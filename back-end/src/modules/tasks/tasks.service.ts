import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
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
    @Inject(forwardRef(() => MilestonesService)) private milestones: MilestonesService,
    @Inject(forwardRef(() => ProposalsService)) private proposals: ProposalsService,
    @Inject(forwardRef(() => NotificationsService)) private notifications: NotificationsService,
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
    // client could otherwise post projects on another client's account.
    // Operations staff create on a client's behalf, so they must name one.
    let clientId = actor.id;
    if (actor.role === ROLES.SUPERUSER) {
      if (!dto.clientId || !this.users.isActiveClient(dto.clientId)) {
        throw new BadRequestException('Choose an active client account to create this task for.');
      }
      clientId = dto.clientId;
    }

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
    task.status = 'open';
    return task;
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
      if (dto.status !== 'cancelled' || existing.status !== 'open' || existing.workerId) {
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
    }

    if (patch.status === 'cancelled') {
      this.ledger.refundRemaining(id, existing.clientId, `Project cancelled — ${existing.title}`, ['project', 'audit', 'dispute']);
      this.proposals.closeAllForTask(id);
    }

    return this.tasksRepository.update(id, patch);
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
    task.status = 'cancelled';
    return { task, refunds };
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
    this.ledger.refundRemaining(id, task.clientId, `Project deleted — ${task.title}`, ['project', 'audit', 'dispute']);
    this.auditRequests.cancelOpenForTask(id);
    this.proposals.closeAllForTask(id);
    this.milestones.removeAllForTask(id);
    this.tasksRepository.deleteById(id);
    return { deleted: true };
  }

  private notify(userId: string | null | undefined, n: { type: string; text: string; subtext?: string; link?: string }) {
    if (!userId) return;
    try { this.notifications.create({ userId, ...n } as any); } catch { /* best-effort */ }
  }

  resetToSeed() {
    this.tasksRepository.resetToSeed();
  }
}
