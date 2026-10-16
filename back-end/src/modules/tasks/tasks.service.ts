import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Inject, forwardRef, OnModuleInit } from '@nestjs/common';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { TasksRepository } from './tasks.repository';
import { LedgerService } from '../ledger/ledger.service';
import { AuditRequestsService } from '../audit-requests/audit-requests.service';
import { UsersService } from '../users/users.service';
import { MilestonesService } from '../milestones/milestones.service';
import { ProposalsService } from '../proposals/proposals.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Actor } from '../../common/decorators/actor.decorator';
import { canViewAnyRecord, assertAllowed } from '../../common/guards/viewer.util';
import { ROLES } from '../../common/constants/roles';
import { FEE_CONFIG, cancellationRate, round2 } from '../ledger/fee-config';

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
export class TasksService implements OnModuleInit {
  constructor(
    private readonly tasksRepository: TasksRepository,
    @Inject(forwardRef(() => LedgerService)) private ledger: LedgerService,
    @Inject(forwardRef(() => AuditRequestsService)) private auditRequests: AuditRequestsService,
    @Inject(forwardRef(() => UsersService)) private users: UsersService,
    @Inject(forwardRef(() => MilestonesService)) private milestones: MilestonesService,
    @Inject(forwardRef(() => ProposalsService)) private proposals: ProposalsService,
    @Inject(forwardRef(() => NotificationsService)) private notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.users.setStatsProvider((id, role) => this.statsFor(id, role));
  }

  /**
   * A person's track record, worked out from what actually happened:
   *   - workers and clients: projects completed and in progress;
   *   - experts: engagements completed and paid.
   * Nothing here is stored, so nothing can be typed in or go stale. (There is
   * no rating system, so no rating is reported.)
   */
  statsFor(id: string, role: string): Record<string, any> {
    if (role === ROLES.EXPERT) {
      return { reviewsDone: this.safeCount(() => this.auditRequests.paidReviewCount(id)) };
    }
    if (role !== ROLES.WORKER && role !== ROLES.CLIENT) return {};
    const side = role === ROLES.WORKER ? 'workerId' : 'clientId';
    const mine = this.tasksRepository.findAll({}).filter((t: any) => t[side] === id);
    return {
      completedProjects: mine.filter((t: any) => t.status === 'completed').length,
      activeProjects: mine.filter((t: any) => t.status === 'in-progress').length,
    };
  }

  private safeCount(fn: () => number): number {
    try { return fn(); } catch { return 0; }
  }

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
    return tasks.filter(t => t.status !== 'draft' || (viewerId && this.canSeeDraft(t, viewerId)));
  }

  /**
   * A single task. A draft is visible to its client, staff who read every
   * record, and the reviewer it is waiting on — not to anyone with the id.
   */
  findById(id: string, viewer?: { id?: string; role?: string }) {
    const task = this.tasksRepository.findById(id);
    if (!task) throw new NotFoundException(`Task with id "${id}" not found`);
    if (viewer && task.status === 'draft' && !canViewAnyRecord(viewer.role) && !this.canSeeDraft(task, viewer.id)) {
      throw new NotFoundException(`Task with id "${id}" not found`);
    }
    return task;
  }

  private canSeeDraft(task: any, viewerId?: string) {
    if (!viewerId) return false;
    return task.clientId === viewerId || this.reviewersOf(task.id).includes(viewerId);
  }

  /** Every reviewer engaged on this task — its audits and its disputes. */
  reviewersOf(taskId: string): string[] {
    try {
      return this.auditRequests
        .findAll({ taskId })
        .map((a: any) => a.expertId)
        .filter(Boolean);
    } catch {
      return [];
    }
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
    // client could otherwise post projects on another client's account. Only
    // clients post projects: the budget comes out of the poster's own wallet,
    // so nobody (operations staff included) can post one for someone else.
    assertAllowed(actor.role === ROLES.CLIENT, 'Only clients can post projects.');
    const clientId = actor.id;

    // Validate the reviewer before anything is stored or charged.
    if (dto.auditEnabled) {
      if (!dto.auditExpertId) {
        throw new BadRequestException('Select an Expert Reviewer for the technical audit before publishing.');
      }
      if (!dto.auditFee || dto.auditFee < 1) {
        throw new BadRequestException('Enter an opening offer of at least $1 for the technical audit.');
      }
      this.auditRequests.assertAssignableExpert(dto.auditExpertId, dto.category);
    }

    // A project that requires a technical audit is not fully created until an
    // expert has accepted and their fee is in escrow. Until then it is a draft:
    // invisible in browse listings and un-hireable.
    const id = this.tasksRepository.generateId();
    const task = {
      ...dto,
      id,
      clientId,
      status: dto.auditEnabled ? 'draft' : 'open',
      progress: 0,
      workerId: null,
      createdAt: new Date().toISOString().slice(0, 10),
      // When workers could first see it — the cancellation clock. A draft
      // goes live when its audit is accepted.
      publishedAt: dto.auditEnabled ? null : new Date().toISOString(),
      // The most this project has ever held, so a client cannot cut the
      // budget to a dollar and then cancel for a dollar's fee.
      peakBudget: dto.budget,
      currency: dto.currency || 'USD',
      skills: dto.skills || [],
      auditEnabled: !!dto.auditEnabled,
    };
    delete (task as any).auditDomain;

    // The budget moves into escrow as the project is posted. If the client
    // cannot cover it, nothing is stored.
    this.ledger.fundProjectBudget(id, clientId, task.budget, task.title);
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
        // with no engagement could never go live, so undo it completely.
        this.ledger.refundRemaining(id, clientId, 'Project could not be created — budget returned');
        this.tasksRepository.deleteById(task.id);
        throw e;
      }
    }

    this.notify(task.auditEnabled ? dto.auditExpertId : null, {
      type: 'audit-request',
      text: 'You have been asked to audit a project',
      subtext: `${task.title} — review the scope and send your quote`,
      link: '/expert-audit-requests',
    });

    return this.tasksRepository.findById(task.id);
  }

  /** Releases a draft project once its audit is funded and accepted. */
  publishDraft(id: string) {
    const task = this.findById(id);
    if (task.status !== 'draft') return task;
    return this.tasksRepository.update(id, { status: 'open', publishedAt: new Date().toISOString() });
  }

  /**
   * What cancelling would cost. Only a project nobody has been hired for can
   * be cancelled; once a worker is on it the contract stands and nothing is
   * refunded by cancelling. The fee applies to the project budget only —
   * audit and dispute escrow is always returned in full.
   */
  cancellationQuote(id: string, actor?: Actor) {
    const task = actor ? this.findOwned(id, actor) : this.findById(id);
    const escrow = this.ledger.getEscrow(id);
    const base = round2(Math.max(Number(task.peakBudget) || 0, Number(task.budget) || 0));
    const liveSince = task.publishedAt || (task.status === 'open' ? task.createdAt : null);
    const hoursLive = liveSince ? Math.max(0, (Date.now() - new Date(liveSince).getTime()) / 3600000) : 0;
    const cancellable = !task.workerId && ['open', 'draft'].includes(task.status);
    // A draft has never been visible to workers, so it costs nothing.
    const rate = task.status === 'draft' || !liveSince ? 0 : cancellationRate(hoursLive);
    const fee = round2(Math.min(round2(base * (rate / 100)), escrow.projectHeld));
    return {
      cancellable,
      reason: cancellable ? null : task.workerId
        ? 'A worker has been hired, so this project can no longer be cancelled or refunded.'
        : `A ${task.status} project cannot be cancelled.`,
      status: task.status,
      hoursLive: Math.round(hoursLive * 10) / 10,
      rate,
      base,
      fee,
      refund: {
        project: round2(escrow.projectHeld - fee),
        audit: escrow.auditHeld,
        dispute: escrow.disputeHeld,
        total: round2(escrow.projectHeld - fee + escrow.auditHeld + escrow.disputeHeld),
      },
      policy: { ...FEE_CONFIG.cancellation },
    };
  }

  /** Keeps the cancellation fee, then returns everything else held for the project. */
  private settleCancellation(task: any, reason: string, chargeFee: boolean) {
    const quote = this.cancellationQuote(task.id);
    const fee = chargeFee && quote.fee > 0
      ? this.ledger.chargeCancellationFee({
          taskId: task.id, clientId: task.clientId, amount: quote.fee, rate: quote.rate, base: quote.base, title: task.title,
        })
      : null;
    const refunds = this.ledger.refundRemaining(task.id, task.clientId, reason, ['project', 'audit', 'dispute']);
    this.auditRequests.cancelOpenForTask(task.id);
    this.proposals.closeAllForTask(task.id);
    return { fee, refunds };
  }

  /**
   * A client edits their own project.
   *
   * Only descriptive fields. The budget can change only before anyone is
   * hired, and escrow follows it — a raise is funded from the wallet, a cut
   * refunded. The only status a client may set is `cancelled`, on a project
   * nobody has been hired for — everything else is the lifecycle's to decide
   * (hire → in-progress, last milestone settled → completed).
   */
  update(id: string, dto: UpdateTaskDto, actor: Actor) {
    const existing = this.findOwned(id, actor);
    const patch: Record<string, any> = {};

    for (const key of ['title', 'description', 'category', 'deadline', 'skills', 'currency'] as const) {
      if (dto[key] !== undefined) patch[key] = dto[key];
    }
    if (patch.category && patch.category !== existing.category && existing.status !== 'open') {
      throw new BadRequestException('The category cannot change once the project has a reviewer or a worker.');
    }

    if (dto.status !== undefined && dto.status !== existing.status) {
      if (existing.status === 'draft') {
        throw new BadRequestException(
          'This project is awaiting its technical audit. Cancel the draft from Audit Offers to get your money back.',
        );
      }
      if (dto.status === 'cancelled' && existing.workerId) {
        throw new BadRequestException(
          'A worker has been hired, so this project can no longer be cancelled or refunded.',
        );
      }
      if (dto.status !== 'cancelled' || existing.status !== 'open') {
        throw new BadRequestException(
          'Project status follows the work: it starts when you hire and completes when the last milestone is settled. ' +
            'You can only cancel an open project with nobody hired.',
        );
      }
      patch.status = 'cancelled';
    }

    if (dto.budget !== undefined && dto.budget !== existing.budget) {
      if (!['open', 'draft'].includes(existing.status) || existing.workerId || patch.status === 'cancelled') {
        throw new BadRequestException('The budget cannot change once a worker is hired — escrow is committed to the contract.');
      }
      const allocated = this.milestones.totalBudget(id);
      if (dto.budget < allocated) {
        throw new BadRequestException(
          `Milestones on this project already add up to $${allocated}. Lower or remove them before cutting the budget below that.`,
        );
      }
      this.ledger.adjustProjectBudget(id, existing.clientId, dto.budget, existing.title);
      patch.budget = dto.budget;
      patch.peakBudget = Math.max(Number(existing.peakBudget) || 0, Number(existing.budget) || 0, dto.budget);
    }

    let cancellation: any = null;
    if (patch.status === 'cancelled') {
      cancellation = this.settleCancellation(existing, `Project cancelled — ${existing.title}`, true);
      patch.cancelledAt = new Date().toISOString();
    }

    const updated = this.tasksRepository.update(id, patch);
    return cancellation ? { ...updated, cancellation } : updated;
  }

  /** Lifecycle: a hire was funded. */
  assignWorker(id: string, workerId: string) {
    return this.tasksRepository.update(id, { workerId, status: 'in-progress' });
  }

  /**
   * Lifecycle: milestone settlements roll up into the task. When the last one
   * settles, whatever is still held for the project — a budget the milestones
   * did not use up, the odd cent of a split — goes back to the client, so a
   * finished project holds nothing.
   */
  setProgress(id: string, progress: number, status: string) {
    const before = this.tasksRepository.findById(id);
    const updated = this.tasksRepository.update(id, { progress, status });
    if (status === 'completed' && before && before.status !== 'completed') {
      this.ledger.refundRemaining(id, before.clientId, `Project completed — unused budget returned (${before.title})`);
      this.auditRequests.closeProjectAudit(id);
    }
    return updated;
  }

  /**
   * Abandons a draft project and returns every cent held for it — the budget
   * and any audit escrow — to the client.
   */
  cancelDraft(id: string, actor: Actor) {
    const task = this.findOwned(id, actor);
    if (task.status !== 'draft') {
      throw new BadRequestException('Only a draft project can be cancelled this way.');
    }
    const refunds = this.ledger.refundRemaining(id, task.clientId, `Draft project cancelled — ${task.title}`, ['project', 'audit']);
    this.auditRequests.cancelOpenForTask(id);
    // Written through the repository: mutating the object only worked while
    // findById happened to hand back the stored reference.
    const cancelled = this.tasksRepository.update(id, { status: 'cancelled', cancelledAt: new Date().toISOString() });
    return { task: cancelled, refunds };
  }

  /**
   * Deletes a project nobody was hired for. Anything still held for it is
   * refunded first, so deleting never strands money.
   */
  delete(id: string, actor: Actor) {
    const task = this.findOwned(id, actor);
    if (task.workerId) {
      throw new ForbiddenException('A project with a hired worker cannot be deleted.');
    }
    if (!['open', 'cancelled', 'draft'].includes(task.status)) {
      throw new ForbiddenException('Only a project that never started can be deleted.');
    }
    // Deleting a live project is a cancellation too, so the client pays the
    // same fee — otherwise deleting would be a free way round it. A superuser
    // removing a project (moderation) returns everything.
    const chargeFee = task.status === 'open' && actor.role !== ROLES.SUPERUSER;
    const { fee, refunds } = this.settleCancellation(task, `Project deleted — ${task.title}`, chargeFee);
    this.milestones.removeAllForTask(id);
    this.tasksRepository.deleteById(id);
    return { deleted: true, fee, refunds };
  }

  private notify(userId: string | null | undefined, n: { type: string; text: string; subtext?: string; link?: string }) {
    if (!userId) return;
    try { this.notifications.create({ userId, ...n } as any); } catch { /* best-effort */ }
  }

  resetToSeed() {
    this.tasksRepository.resetToSeed();
  }
}
