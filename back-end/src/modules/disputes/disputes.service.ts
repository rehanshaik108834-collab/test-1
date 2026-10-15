import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { CreateDisputeDto } from './dto/create-dispute.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import { DisputesRepository } from './disputes.repository';
import { MilestonesService } from '../milestones/milestones.service';
import { TasksService } from '../tasks/tasks.service';
import { LedgerService } from '../ledger/ledger.service';
import { canViewTask, canViewAnyRecord } from '../../common/guards/viewer.util';
import { AuditRequestsService } from '../audit-requests/audit-requests.service';
import { AppLoggerService } from '../../common/logging/app-logger.service';
import { UsersService } from '../users/users.service';
import { Actor } from '../../common/decorators/actor.decorator';
import { assertAllowed } from '../../common/guards/viewer.util';
import { NotificationsService } from '../notifications/notifications.service';
import { SETTLED } from '../milestones/milestones.service';
import { round2 } from '../ledger/fee-config';
import { ROLES } from '../../common/constants/roles';

const today = () => new Date().toISOString().slice(0, 10);

const VERDICT_TEXT: Record<string, string> = {
  'worker-favour': 'in favour of the worker',
  'client-favour': 'in favour of the client',
  split: 'split 50/50',
  revision: 'the worker revises the milestone',
};

/**
 * DisputesService — Business Logic Layer
 *
 * Handles dispute creation, resolution, and milestone status updates.
 * Delegates all data-access operations to DisputesRepository.
 */
@Injectable()
export class DisputesService {
  constructor(
    private readonly disputesRepository: DisputesRepository,
    @Inject(forwardRef(() => MilestonesService)) private milestonesService: MilestonesService,
    @Inject(forwardRef(() => TasksService)) private tasksService: TasksService,
    @Inject(forwardRef(() => LedgerService)) private ledger: LedgerService,
    @Inject(forwardRef(() => AuditRequestsService)) private auditRequests: AuditRequestsService,
    @Inject(forwardRef(() => UsersService)) private users: UsersService,
    private readonly log: AppLoggerService,
    @Inject(forwardRef(() => NotificationsService)) private notifications: NotificationsService,
  ) {}

  findAll(viewer?: { id?: string; role?: string }) {
    const all = this.disputesRepository.findAll();
    if (!viewer || canViewAnyRecord(viewer.role)) return all;
    // Visible to the parties and the reviewer arbitrating it — not to every
    // reviewer on the platform, which is what an unguarded GET allowed.
    return all.filter((d: any) => this.canView(d, viewer));
  }

  findById(id: string, viewer?: { id?: string; role?: string }) {
    const d = this.disputesRepository.findById(id);
    if (!d) throw new NotFoundException(`Dispute with id "${id}" not found`);
    if (viewer && !this.canView(d, viewer)) {
      throw new ForbiddenException(
        'You do not have access to this dispute. Only the people involved can view it.',
      );
    }
    return d;
  }

  private canView(d: any, viewer: { id?: string; role?: string }): boolean {
    const task = d.taskId ? this.safe(() => this.tasksService.findById(d.taskId)) : null;
    return canViewTask(viewer.id, viewer.role, task, d.expertId, d.raisedBy, d.againstId, ...this.reviewersOfDispute(d));
  }

  /** Reviewers who were engaged on this dispute at any point (so a past reviewer can still read it). */
  private reviewersOfDispute(d: any): string[] {
    return this.safe(() =>
      this.auditRequests.findAll({ kind: 'dispute-audit' })
        .filter((a: any) => a.disputeId === d.id)
        .flatMap((a: any) => [a.expertId, a.declinedBy])
        .filter(Boolean),
    ) || [];
  }

  private safe<T>(fn: () => T): T | null {
    try { return fn(); } catch { return null; }
  }

  create(dto: CreateDisputeDto, actor: Actor) {
    // Parties come from the project, not the body. `raisedBy` and `againstId`
    // were taken as sent, so anyone could open a dispute in someone else's
    // name — on a project they had nothing to do with.
    const task = this.tasksService.findById(dto.taskId);
    if (!task.workerId) {
      throw new BadRequestException('A dispute needs a hired worker — nobody is working on this project yet.');
    }
    const isClient = task.clientId === actor.id;
    const isWorker = task.workerId === actor.id;
    assertAllowed(isClient || isWorker, 'Only the client and the worker on this project can raise a dispute about it.');
    const againstId = isClient ? task.workerId : task.clientId;

    if (!dto.milestoneId) throw new BadRequestException('Choose the milestone this dispute is about.');
    const ms = this.milestonesService.findById(dto.milestoneId);
    if (ms.taskId !== task.id) throw new BadRequestException('That milestone does not belong to this project.');
    if (SETTLED.includes(ms.status)) {
      throw new BadRequestException('This milestone has already been settled and can no longer be disputed.');
    }
    const open = this.disputesRepository
      .findAll()
      .find((d: any) => d.milestoneId === dto.milestoneId && d.status === 'open');
    if (open) throw new BadRequestException('There is already an open dispute on this milestone.');

    // Check the reviewer before recording anything, so a dispute is never
    // stored with a reviewer who could not take the case.
    if (!dto.expertId) throw new BadRequestException('Choose the Expert Reviewer who will arbitrate this dispute.');
    if (!dto.reviewerFee || dto.reviewerFee < 1) {
      throw new BadRequestException('Enter the fee you will pay the reviewer (at least $1).');
    }
    this.auditRequests.assertAssignableExpert(dto.expertId, task.category);

    const nameOf = (id: string) => this.safe(() => this.users.findById(id))?.name || '';
    const dispute: any = {
      taskId: task.id,
      milestoneId: ms.id,
      reason: dto.reason,
      details: dto.details || '',
      outcome: dto.outcome || '',
      project: task.title,
      milestone: ms.title,
      // What is actually at stake is the milestone's escrow, not a typed string.
      amount: `$${ms.budget}`,
      raisedBy: actor.id,
      raisedByName: nameOf(actor.id),
      againstId,
      againstName: nameOf(againstId),
      // Whoever raises the dispute pays the reviewer to arbitrate it.
      payerId: actor.id,
      reviewerFee: dto.reviewerFee,
      id: this.disputesRepository.generateId(),
      status: 'open',
      expertId: dto.expertId,
      verdict: null,
      resolution: null,
      createdAt: new Date().toISOString().slice(0, 10),
      resolvedAt: null,
      milestoneStatusBefore: ms.status,
    };

    // Open the engagement first: if it cannot be opened, no dispute is stored
    // and the milestone is untouched.
    const auditRequest = this.auditRequests.create({
      kind: 'dispute-audit',
      taskId: task.id,
      milestoneId: ms.id,
      clientId: task.clientId,
      workerId: task.workerId,
      payerId: actor.id,
      disputeId: dispute.id,
      expertId: dto.expertId,
      category: task.category,
      severity: 'High',
      project: task.title,
      milestone: ms.title,
      status: 'preview-sent',
      openingOffer: dto.reviewerFee,
    });
    dispute.auditRequestId = auditRequest.id;
    this.disputesRepository.insert(dispute);
    this.milestonesService.systemUpdate(ms.id, { status: 'disputed' });

    this.notifications.notify(againstId, {
      type: 'dispute',
      text: `${dispute.raisedByName || 'The other party'} raised a dispute`,
      subtext: `${task.title} — ${ms.title}: ${dto.reason}`,
      link: isClient ? `/worker-milestone-board?id=${task.id}` : `/project-milestone-board?id=${task.id}`,
    });
    this.notifications.notify(dto.expertId, {
      type: 'dispute',
      text: 'You have been asked to arbitrate a dispute',
      subtext: `${task.title} — review the claim and send your quote`,
      link: `/expert-audit-preview?id=${auditRequest.id}`,
    });

    return dispute;
  }

  /** The dispute's reviewer changed — a decline cleared it, or the payer chose someone else. */
  setReviewer(disputeId: string, expertId: string | null, auditRequestId: string) {
    const d = this.disputesRepository.findById(disputeId);
    if (!d || d.status !== 'open') return d;
    return this.disputesRepository.update(disputeId, { expertId, auditRequestId });
  }

  /**
   * The verdict. It moves the milestone's escrow, closes the milestone, and —
   * when given by the assigned reviewer — pays that reviewer the fee they were
   * hired for. Operations staff may override a stuck dispute; the reviewer's
   * held fee then goes back to whoever paid it.
   */
  resolve(id: string, dto: ResolveDisputeDto, actor: Actor) {
    const dispute = this.findById(id);
    if (dispute.status !== 'open') {
      throw new BadRequestException(`This dispute is already ${dispute.status}.`);
    }
    const override = actor.role === ROLES.SUPERUSER;
    if (!override) {
      assertAllowed(
        dispute.expertId && dispute.expertId === actor.id,
        'Only the Expert Reviewer assigned to this dispute can resolve it.',
      );
    }

    // Refuse before any money moves.
    let engagement: any = null;
    if (!override) {
      engagement = dispute.auditRequestId ? this.safe(() => this.auditRequests.findById(dispute.auditRequestId)) : null;
      if (!engagement || engagement.status !== 'in-progress') {
        throw new BadRequestException(
          'Agree your fee, have it funded and accept the engagement before giving a verdict.',
        );
      }
    }

    const ms = dispute.milestoneId ? this.milestonesService.findById(dispute.milestoneId) : null;
    const task = this.tasksService.findById(dispute.taskId);
    if (ms && dto.verdict !== 'revision' && this.ledger.isMilestoneReleased(ms.id)) {
      throw new BadRequestException('This milestone has already been paid out.');
    }

    // Move the money the verdict implies.
    let settlement: any = null;
    if (ms) {
      if (dto.verdict === 'worker-favour') {
        settlement = this.ledger.releaseMilestone({
          milestoneId: ms.id, taskId: task.id, clientId: task.clientId, workerId: ms.workerId,
          amount: ms.budget, description: `Dispute resolved in the worker's favour — ${ms.title}`,
        });
        this.milestonesService.systemUpdate(ms.id, { status: 'completed', approvedAt: today(), progress: 100 });
      } else if (dto.verdict === 'client-favour') {
        // The milestone's money goes back and the milestone closes. Sending it
        // back for revision as well would leave work with nothing behind it in
        // escrow — its approval would then spend other milestones' money.
        settlement = this.ledger.refundToClient({
          taskId: task.id, clientId: task.clientId, amount: ms.budget,
          reason: `Dispute resolved in the client's favour — ${ms.title}`,
        });
        this.milestonesService.systemUpdate(ms.id, { status: 'refunded', refundedAt: today() });
      } else if (dto.verdict === 'split') {
        const half = round2(ms.budget / 2);
        const release = this.ledger.releaseMilestone({
          milestoneId: ms.id, taskId: task.id, clientId: task.clientId, workerId: ms.workerId,
          amount: half, description: `Dispute split — worker's share of ${ms.title}`,
        });
        const refund = this.ledger.refundToClient({
          taskId: task.id, clientId: task.clientId, amount: round2(ms.budget - half),
          reason: `Dispute split — client's share of ${ms.title}`,
        });
        settlement = { release, refund };
        this.milestonesService.systemUpdate(ms.id, { status: 'completed', approvedAt: today(), progress: 100 });
      } else if (dto.verdict === 'revision') {
        // No money moves: the escrow stays behind the milestone and the
        // worker reworks it against the reviewer's notes.
        this.milestonesService.systemUpdate(ms.id, {
          status: 'revision-needed', revisionNote: dto.resolution, revisionRequestedAt: new Date().toISOString(),
        });
      }
    }

    // The reviewer is paid for the verdict; an override refunds their held fee.
    const reviewerPayout = override
      ? { refunded: this.auditRequests.closeForDispute(dispute.id, 'Dispute settled by operations — reviewer fee returned') }
      : this.auditRequests.settleDispute(engagement.id);

    const resolved = this.disputesRepository.update(id, {
      status: 'resolved',
      verdict: dto.verdict,
      resolution: dto.resolution,
      resolvedAt: today(),
      resolvedBy: actor.id,
      overriddenBy: override ? actor.id : null,
    });
    if (ms) this.milestonesService.checkTaskCompletion(dispute.taskId);

    const label = VERDICT_TEXT[dto.verdict] || dto.verdict;
    for (const userId of [dispute.raisedBy, dispute.againstId, override ? dispute.expertId : null]) {
      this.notifications.notify(userId, {
        type: 'dispute-resolved',
        text: `Dispute resolved: ${label}`,
        subtext: `${dispute.project || task.title} — ${dispute.milestone || 'milestone'}`,
        link: `/expert-report-dispute?id=${dispute.id}`,
      });
    }

    return { ...resolved, settlement, reviewerPayout };
  }

  resetToSeed() {
    this.disputesRepository.resetToSeed();
  }
}
