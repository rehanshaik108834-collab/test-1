import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { CreateMilestoneDto } from './dto/create-milestone.dto';
import { UpdateMilestoneDto } from './dto/update-milestone.dto';
import { MilestonesRepository } from './milestones.repository';
import { TasksService } from '../tasks/tasks.service';
import { UsersService } from '../users/users.service';
import { TransactionsService } from '../transactions/transactions.service';
import { LedgerService } from '../ledger/ledger.service';
import { AuditRequestsService } from '../audit-requests/audit-requests.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AppLoggerService } from '../../common/logging/app-logger.service';
import { Actor } from '../../common/decorators/actor.decorator';
import { assertAllowed } from '../../common/guards/viewer.util';
import { ROLES } from '../../common/constants/roles';

/** Statuses a worker moves their own milestone between while working on it. */
const WORKER_SETTABLE = ['pending', 'in-progress'];
/** Statuses from which a worker may pick the milestone back up. */
const WORKER_FROM = ['pending', 'in-progress', 'revision-needed'];
/** A milestone that has been paid, one way or another. */
const SETTLED = ['completed', 'approved', 'audit-passed', 'done'];

/**
 * MilestonesService — Business Logic Layer
 *
 * Handles submission, approval, audit-request creation, and task-completion checks.
 * Delegates all data-access operations to MilestonesRepository.
 */
@Injectable()
export class MilestonesService {
  constructor(
    private readonly milestonesRepository: MilestonesRepository,
    @Inject(forwardRef(() => TasksService)) private tasksService: TasksService,
    @Inject(forwardRef(() => UsersService)) private usersService: UsersService,
    @Inject(forwardRef(() => TransactionsService)) private transactionsService: TransactionsService,
    @Inject(forwardRef(() => LedgerService)) private ledger: LedgerService,
    @Inject(forwardRef(() => AuditRequestsService)) private auditRequestsService: AuditRequestsService,
    @Inject(forwardRef(() => NotificationsService)) private notificationsService: NotificationsService,
    private readonly log: AppLoggerService,
  ) {}

  findAll(query?: { taskId?: string }) {
    return this.milestonesRepository.findAll(query);
  }

  findById(id: string) {
    const ms = this.milestonesRepository.findById(id);
    if (!ms) throw new NotFoundException(`Milestone with id "${id}" not found`);
    return ms;
  }

  /** The milestone's task, plus whether the caller is its client or its worker. */
  private roleOn(ms: any, actor: Actor) {
    const task = this.tasksService.findById(ms.taskId);
    return {
      task,
      isClient: task.clientId === actor.id || actor.role === ROLES.SUPERUSER,
      isWorker: !!task.workerId && task.workerId === actor.id,
    };
  }

  create(dto: CreateMilestoneDto, actor: Actor) {
    const task = this.tasksService.findById(dto.taskId);
    assertAllowed(
      task.clientId === actor.id || actor.role === ROLES.SUPERUSER,
      'Only the client who owns this project can add milestones to it.',
    );
    if (['completed', 'cancelled'].includes(task.status)) {
      throw new BadRequestException(`Milestones cannot be added to a ${task.status} project.`);
    }
    const ms = {
      ...dto,
      id: this.milestonesRepository.generateId(),
      status: 'pending',
      submittedAt: null,
      approvedAt: null,
      deliverable: null,
      progress: 0,
      priority: dto.priority || 'Medium',
      dueDate: dto.dueDate || null,
      // Payable to whoever is hired on the task — never to an id the body
      // names. A milestone created with the client's own id once paid
      // escrow straight back to them.
      workerId: task.workerId || null,
    };
    return this.milestonesRepository.insert(ms);
  }

  /**
   * A person edits a milestone. The client owns the description and the
   * budget; the worker owns "I have started". Neither can reassign who is
   * paid, and nobody can mark it paid without the money moving — that is
   * what /approve and dispute resolution are for.
   */
  update(id: string, dto: UpdateMilestoneDto, actor: Actor) {
    const ms = this.findById(id);
    const { isClient, isWorker } = this.roleOn(ms, actor);
    assertAllowed(isClient || isWorker, 'Only the client and the worker on this project can change its milestones.');

    const patch: Record<string, any> = {};

    if (isClient) {
      for (const key of ['title', 'description', 'dueDate', 'priority'] as const) {
        if (dto[key] !== undefined) patch[key] = dto[key];
      }
      if (dto.budget !== undefined && dto.budget !== ms.budget) {
        if (!['pending', 'in-progress'].includes(ms.status)) {
          throw new BadRequestException('The budget cannot change once work has been submitted.');
        }
        patch.budget = dto.budget;
      }
    }

    if (dto.progress !== undefined) {
      assertAllowed(isWorker, 'Only the worker reports progress on a milestone.');
      patch.progress = dto.progress;
    }

    if (dto.status !== undefined && dto.status !== ms.status) {
      if (isWorker && WORKER_SETTABLE.includes(dto.status) && WORKER_FROM.includes(ms.status)) {
        patch.status = dto.status;
      } else if (isClient && dto.status === 'revision-needed' && ['submitted', 'review'].includes(ms.status)) {
        // "Request changes" on a submission.
        patch.status = dto.status;
      } else {
        throw new BadRequestException(
          `A milestone cannot move from "${ms.status}" to "${dto.status}" this way. ` +
            'Submitting, approving and disputing each have their own action.',
        );
      }
    }

    return this.milestonesRepository.update(id, patch);
  }

  /** Lifecycle writes the platform makes itself (dispute flags, hire backfill). */
  systemUpdate(id: string, partial: Record<string, any>) {
    const updated = this.milestonesRepository.update(id, partial);
    if (!updated) throw new NotFoundException(`Milestone with id "${id}" not found`);
    return updated;
  }

  submitDeliverable(id: string, deliverable: any, actor: Actor) {
    const ms = this.findById(id);
    const { isWorker } = this.roleOn(ms, actor);
    assertAllowed(isWorker, 'Only the worker hired on this project can submit its milestones.');
    if (SETTLED.includes(ms.status)) {
      throw new BadRequestException('This milestone has already been paid.');
    }
    ms.status = 'submitted';
    ms.submittedAt = new Date().toISOString().slice(0, 10);
    if (deliverable) ms.deliverable = deliverable;

    this.handOverToAuditor(ms);

    return ms;
  }

  /**
   * Points the project's audit engagement at the milestone that now needs
   * reviewing, and tells the reviewer.
   *
   * Two rules live here:
   *
   *  - **Only the assigned reviewer hears about it.** The page that used to do
   *    this looped over every expert account and notified all of them, so
   *    reviewers with no connection to the project were told about work they
   *    could not open.
   *  - **A milestone is audited once.** If a report already exists for it —
   *    the case when a dispute sends the work back and the worker resubmits —
   *    the engagement is left alone and nobody is notified again.
   */
  private handOverToAuditor(ms: any) {
    try {
      const task = this.tasksService.findById(ms.taskId);
      if (!task?.auditEnabled) return;

      const engagement = this.auditRequestsService.activeProjectAudit(ms.taskId);
      if (!engagement || !engagement.expertId) return;

      if (this.auditRequestsService.isMilestoneAudited(engagement, ms.id)) {
        this.log.log(
          'milestones.submit',
          `milestone ${ms.id} was already audited under ${engagement.id}; no second audit raised`,
        );
        return;
      }

      const workerName = this.usersService.findById(ms.workerId)?.name || 'Worker';
      this.auditRequestsService.systemUpdate(engagement.id, {
        milestoneId: ms.id,
        worker: workerName,
        milestone: ms.title,
      });

      this.notificationsService.create({
        userId: engagement.expertId,
        type: 'audit-needed',
        text: 'New deliverable awaiting technical audit',
        subtext: `${ms.title || 'Milestone'} — ${task.title || 'Project'}`,
      } as any);
    } catch (e) {
      // Submission succeeded; only the audit hand-off failed. The reviewer
      // would just never see the milestone, with no clue why.
      this.log.warn(
        'milestones.submit',
        `could not attach milestone ${ms.id} to the active audit engagement`,
        e,
      );
    }
  }

  approveDeliverable(id: string, actor: Actor) {
    const ms = this.findById(id);
    const task = this.tasksService.findById(ms.taskId);
    // Any client could approve any milestone, releasing another client's
    // escrow to the worker.
    assertAllowed(task.clientId === actor.id, 'Only the client who owns this project can approve its milestones.');
    if (ms.status === 'disputed') {
      // The dispute's verdict decides where this money goes; approving now
      // would pay the worker and still leave the verdict free to refund it.
      throw new BadRequestException('This milestone is under dispute. The reviewer verdict will settle it.');
    }

    // Release before marking complete: if escrow cannot cover the milestone the
    // approval must fail rather than mark it paid. LedgerService is idempotent
    // per milestone, so approving twice cannot pay twice.
    const release = this.ledger.releaseMilestone({
      milestoneId: id,
      taskId: ms.taskId,
      clientId: task.clientId,
      workerId: ms.workerId,
      amount: ms.budget,
      description: `Payment for ${ms.title}`,
    });

    ms.status = 'completed';
    ms.approvedAt = new Date().toISOString().slice(0, 10);
    ms.progress = 100;

    this.checkTaskCompletion(ms.taskId);

    return { ...ms, release };
  }

  checkTaskCompletion(taskId: string) {
    if (!taskId) return;
    try {
      const task = this.tasksService.findById(taskId);
      const allMilestones = this.milestonesRepository.filterByTaskId(taskId);
      if (!allMilestones.length) return;

      const done = allMilestones.filter(m =>
        ['completed', 'approved', 'audit-passed', 'done'].includes(m.status)
      ).length;
      const pct = Math.round((done / allMilestones.length) * 100);

      this.tasksService.setProgress(taskId, pct, pct === 100 ? 'completed' : 'in-progress');
    } catch (e) {
      this.log.warn(
        'milestones.checkTaskCompletion',
        `could not roll progress up to task ${taskId}`,
        e,
      );
    }
  }

  resetToSeed() {
    this.milestonesRepository.resetToSeed();
  }
}
