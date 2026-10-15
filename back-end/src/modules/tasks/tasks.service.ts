import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { TasksRepository } from './tasks.repository';
import { LedgerService } from '../ledger/ledger.service';
import { AuditRequestsService } from '../audit-requests/audit-requests.service';
import { UsersService } from '../users/users.service';
import { Actor } from '../../common/decorators/actor.decorator';
import { canViewAnyRecord, assertAllowed } from '../../common/guards/viewer.util';
import { ROLES } from '../../common/constants/roles';

/**
 * TasksService — Business Logic Layer
 *
 * Handles validation and error handling.
 * Delegates all data-access operations to TasksRepository.
 *
 * Two kinds of write live here, and they are kept apart on purpose:
 *   - `update()` is what a person asks for over HTTP. It is checked against
 *     the caller and may only touch descriptive fields.
 *   - `assignWorker()` / `setProgress()` are the lifecycle moves the platform
 *     makes itself (a hire, a milestone approval). They used to share the
 *     public `update()`, which is why that route accepted `workerId`,
 *     `status` and `progress` from anyone.
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly tasksRepository: TasksRepository,
    @Inject(forwardRef(() => LedgerService)) private ledger: LedgerService,
    @Inject(forwardRef(() => AuditRequestsService)) private auditRequests: AuditRequestsService,
    @Inject(forwardRef(() => UsersService)) private users: UsersService,
  ) {}

  /**
   * A draft is an audit-gated project that has not gone live yet. It is
   * visible to its own client and to staff who may read any record — never in
   * anyone else's listing. Previously `?status=draft` (or any `clientId`
   * filter) skipped this check and listed every draft on the platform.
   */
  findAll(
    query?: { clientId?: string; workerId?: string; status?: string },
    viewer?: { id?: string; role?: string } | 'system',
  ) {
    const tasks = this.tasksRepository.findAll(query || {});
    if (viewer === 'system') return tasks;
    if (viewer && canViewAnyRecord(viewer.role)) return tasks;
    const viewerId = viewer ? viewer.id : undefined;
    return tasks.filter(t => t.status !== 'draft' || (viewerId && t.clientId === viewerId));
  }

  findById(id: string) {
    const task = this.tasksRepository.findById(id);
    if (!task) throw new NotFoundException(`Task with id "${id}" not found`);
    return task;
  }

  /** The task, if the caller is its client (or operations staff). */
  private findOwned(id: string, actor: Actor) {
    const task = this.findById(id);
    assertAllowed(
      task.clientId === actor.id || actor.role === ROLES.SUPERUSER,
      'Only the client who owns this project can change it.',
    );
    return task;
  }

  create(dto: CreateTaskDto, actor: Actor) {
    // The owner is the caller, not whatever `clientId` the body named — a
    // client could otherwise post projects on another client's account.
    // Operations staff create on a client's behalf, so they must name one.
    let clientId = actor.id;
    if (actor.role === ROLES.SUPERUSER) {
      if (!dto.clientId || !this.users.isActiveClient(dto.clientId)) {
        throw new BadRequestException('Choose an active client account to create this task for.');
      }
      clientId = dto.clientId;
    }

    // Validate the reviewer before anything is stored. This used to insert the
    // task first and then mark it cancelled when the reviewer was missing or
    // invalid, leaving a junk record behind on every failed attempt.
    if (dto.auditEnabled) {
      if (!dto.auditExpertId) {
        throw new BadRequestException('Select an Expert Reviewer for the technical audit before publishing.');
      }
      this.auditRequests.assertAssignableExpert(dto.auditExpertId, dto.category);
    }

    // A project that requires a technical audit is not fully created until an
    // expert has accepted and their fee is in escrow. Until then it is a draft:
    // invisible in browse listings and un-hireable.
    const task = {
      ...dto,
      id: this.tasksRepository.generateId(),
      clientId,
      status: dto.auditEnabled ? 'draft' : 'open',
      progress: 0,
      workerId: null,
      createdAt: new Date().toISOString().slice(0, 10),
      currency: dto.currency || 'USD',
      skills: dto.skills || [],
      auditEnabled: !!dto.auditEnabled,
    };
    this.tasksRepository.insert(task);

    // An audited project opens its expert engagement immediately, carrying the
    // client's opening offer. The project stays a draft until an expert accepts.
    if (task.auditEnabled) {
      try {
        this.auditRequests.create({
          kind: 'project-audit',
          taskId: task.id,
          clientId: task.clientId,
          // The client picks one reviewer; only they can see this engagement.
          expertId: dto.auditExpertId,
          category: task.category,
          severity: 'Medium',
          project: task.title,
          status: 'preview-sent',
          openingOffer: dto.auditFee,
          dueDate: task.deadline,
        });
      } catch (e) {
        // The reviewer was checked above, so this is unexpected — but a draft
        // with no engagement could never go live, so do not keep it.
        this.tasksRepository.deleteById(task.id);
        throw e;
      }
    }

    return this.tasksRepository.findById(task.id);
  }

  /** Releases a draft project once its audit is funded and accepted. */
  publishDraft(id: string) {
    const task = this.findById(id);
    if (task.status !== 'draft') return task;
    task.status = 'open';
    return task;
  }

  /**
   * A client edits their own project.
   *
   * Only descriptive fields. The budget is fixed once a worker is hired,
   * because escrow was funded against it. The only status a client may set
   * is `cancelled`, on an open project nobody has been hired for — everything
   * else is the lifecycle's to decide (hire → in-progress, last milestone
   * approved → completed).
   */
  update(id: string, dto: UpdateTaskDto, actor: Actor) {
    const existing = this.findOwned(id, actor);
    const patch: Record<string, any> = {};

    for (const key of ['title', 'description', 'category', 'deadline', 'skills', 'currency'] as const) {
      if (dto[key] !== undefined) patch[key] = dto[key];
    }

    if (dto.budget !== undefined && dto.budget !== existing.budget) {
      if (existing.status !== 'open' || existing.workerId) {
        throw new BadRequestException('The budget cannot change once a worker is hired — escrow was funded against it.');
      }
      patch.budget = dto.budget;
    }

    if (dto.status !== undefined && dto.status !== existing.status) {
      if (existing.status === 'draft') {
        throw new BadRequestException(
          'This project is awaiting its technical audit. Cancel the draft from Audit Offers to get the audit escrow back.',
        );
      }
      if (dto.status !== 'cancelled' || existing.status !== 'open' || existing.workerId) {
        throw new BadRequestException(
          'Project status follows the work: it starts when you hire and completes when the last milestone is approved. ' +
            'You can only cancel an open project with nobody hired.',
        );
      }
      patch.status = 'cancelled';
    }

    return this.tasksRepository.update(id, patch);
  }

  /** Lifecycle: a hire was funded. */
  assignWorker(id: string, workerId: string) {
    return this.tasksRepository.update(id, { workerId, status: 'in-progress' });
  }

  /** Lifecycle: milestone approvals roll up into the task. */
  setProgress(id: string, progress: number, status: string) {
    return this.tasksRepository.update(id, { progress, status });
  }

  /**
   * Abandons a draft project and returns any audit escrow to the client.
   * Used when the client gives up before an expert accepts.
   */
  cancelDraft(id: string, actor: Actor) {
    const task = this.findOwned(id, actor);
    if (task.status !== 'draft') {
      throw new BadRequestException('Only a draft project can be cancelled this way.');
    }
    const held = this.ledger.getEscrow(id);
    let refund: any = null;
    if (held.auditHeld > 0) {
      refund = this.ledger.refundAuditEscrow({
        taskId: id,
        clientId: task.clientId,
        amount: held.auditHeld,
        reason: `Draft project cancelled — ${task.title}`,
      });
    }
    task.status = 'cancelled';
    return { task, refund };
  }

  /**
   * Deletes a project that never started. Refused while anyone is hired or
   * any money is held for it — deleting then would strand the escrow with no
   * project to refund it against.
   */
  delete(id: string, actor: Actor) {
    const task = this.findOwned(id, actor);
    const held = this.ledger.getEscrow(id);
    if (task.workerId || held.projectHeld > 0 || held.auditHeld > 0) {
      throw new ForbiddenException('A project with a hired worker or funds in escrow cannot be deleted.');
    }
    if (!['open', 'cancelled'].includes(task.status)) {
      throw new ForbiddenException('Only an open or cancelled project can be deleted.');
    }
    this.tasksRepository.deleteById(id);
    return { deleted: true };
  }

  resetToSeed() {
    this.tasksRepository.resetToSeed();
  }
}
