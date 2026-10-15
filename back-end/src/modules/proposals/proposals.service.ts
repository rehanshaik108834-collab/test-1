import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { UpdateProposalDto } from './dto/update-proposal.dto';
import { ProposalsRepository } from './proposals.repository';
import { TasksService } from '../tasks/tasks.service';
import { TransactionsService } from '../transactions/transactions.service';
import { LedgerService } from '../ledger/ledger.service';
import { MilestonesService } from '../milestones/milestones.service';
import { UsersService } from '../users/users.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Actor } from '../../common/decorators/actor.decorator';
import { assertAllowed, canViewAnyRecord } from '../../common/guards/viewer.util';
import { ROLES } from '../../common/constants/roles';

/**
 * ProposalsService — Business Logic Layer
 *
 * Handles hiring, invitation acceptance/decline, and escrow creation.
 * Delegates all data-access operations to ProposalsRepository.
 *
 * Who may do what:
 *   - a worker bids on an open project, as themselves;
 *   - a client invites a worker to their own open project;
 *   - the client hires from a bid; the invited worker accepts an invitation.
 * Every one of these used to be open to any signed-in user, including a
 * worker inviting themselves to someone else's project and accepting —
 * which charged that client's wallet into escrow.
 */
@Injectable()
export class ProposalsService {
  constructor(
    private readonly proposalsRepository: ProposalsRepository,
    @Inject(forwardRef(() => TasksService)) private tasksService: TasksService,
    @Inject(forwardRef(() => TransactionsService)) private transactionsService: TransactionsService,
    @Inject(forwardRef(() => LedgerService)) private ledger: LedgerService,
    @Inject(forwardRef(() => MilestonesService)) private milestonesService: MilestonesService,
    @Inject(forwardRef(() => UsersService)) private users: UsersService,
    @Inject(forwardRef(() => NotificationsService)) private notifications: NotificationsService,
  ) {}

  /**
   * Internal callers get every row. A worker sees their own bids and
   * invitations in full; a client sees everything on their own projects; on
   * anyone else's open project only a stub is shown — enough to count the
   * competition, never another worker's price or cover letter.
   */
  findAll(query?: { taskId?: string; workerId?: string; type?: string }, viewer?: { id?: string; role?: string }) {
    const all = this.proposalsRepository.findAll(query);
    if (!viewer || canViewAnyRecord(viewer.role)) return all;
    const taskOf: Record<string, any> = {};
    const out: any[] = [];
    for (const p of all) {
      if (!(p.taskId in taskOf)) {
        try { taskOf[p.taskId] = this.tasksService.findById(p.taskId); } catch { taskOf[p.taskId] = null; }
      }
      const task = taskOf[p.taskId];
      if (p.workerId === viewer.id || (task && task.clientId === viewer.id)) out.push(p);
      else if (task && task.status === 'open' && p.type !== 'invitation') {
        out.push({ id: p.id, taskId: p.taskId, type: p.type, status: p.status, createdAt: p.createdAt });
      }
    }
    return out;
  }

  findById(id: string, viewer?: { id?: string; role?: string }) {
    const prop = this.proposalsRepository.findById(id);
    if (!prop) throw new NotFoundException(`Proposal with id "${id}" not found`);
    if (viewer && !canViewAnyRecord(viewer.role) && prop.workerId !== viewer.id) {
      const task = this.tasksService.findById(prop.taskId);
      if (task.clientId !== viewer.id) throw new NotFoundException(`Proposal with id "${id}" not found`);
    }
    return prop;
  }

  /** A project closed before hiring: its pending bids and invitations close with it. */
  closeAllForTask(taskId: string) {
    for (const p of this.proposalsRepository.findAll({ taskId })) {
      if (p.status === 'pending') {
        this.proposalsRepository.update(p.id, { status: 'closed' });
        this.notifications.notify(p.workerId, {
          type: 'proposal',
          text: p.type === 'invitation' ? 'An invitation was withdrawn' : 'A project you bid on was closed',
          subtext: this.titleOf(taskId),
          link: p.type === 'invitation' ? '/worker-invitations' : '/my-proposals',
        });
      }
    }
  }

  private titleOf(taskId: string) {
    try { return this.tasksService.findById(taskId).title; } catch { return 'Project'; }
  }

  /** The task, refusing anything that is not open for bids. */
  private openTask(taskId: string, what: string) {
    // findById throws a 404 for an unknown task. The old version swallowed it,
    // so proposals could be filed against projects that did not exist.
    const task = this.tasksService.findById(taskId);
    if (task.status !== 'open') {
      throw new BadRequestException(`This project is not open — cannot ${what}.`);
    }
    return task;
  }

  create(dto: CreateProposalDto, actor: Actor) {
    const task = this.openTask(dto.taskId, 'submit proposals or invitations');

    let workerId: string;
    let type: string;
    if (actor.role === ROLES.WORKER) {
      // A worker bids as themselves. A bid cannot be an invitation, or the
      // worker could accept it and hire themselves.
      workerId = actor.id;
      type = 'proposal';
    } else if (actor.role === ROLES.CLIENT) {
      assertAllowed(task.clientId === actor.id, 'You can only invite workers to your own projects.');
      if (!dto.workerId) throw new BadRequestException('Choose the worker to invite.');
      workerId = dto.workerId;
      type = 'invitation';
    } else {
      throw new BadRequestException('Only workers submit proposals and only clients send invitations.');
    }

    const worker = this.users.findById(workerId);
    if (worker.role !== ROLES.WORKER || worker.status !== 'active') {
      throw new BadRequestException(`${worker.name} is not an active worker.`);
    }
    const duplicate = this.proposalsRepository
      .findAll({ taskId: task.id })
      .find((p: any) => p.workerId === workerId && p.status === 'pending');
    if (duplicate) {
      throw new BadRequestException(
        type === 'invitation' ? `${worker.name} already has a pending invitation or bid on this project.` : 'You already have a pending proposal on this project.',
      );
    }

    const prop = {
      ...dto,
      id: this.proposalsRepository.generateId(),
      workerId,
      type,
      status: 'pending',
      createdAt: new Date().toISOString().slice(0, 10),
      skills: dto.skills || worker.skills || [],
      // Profile figures come from the record, not the request — a bid could
      // otherwise claim a 5.0 rating and 500 completed projects.
      workerName: worker.name,
      avatar: worker.avatar,
      avatarColor: worker.avatarColor,
      rating: worker.rating,
      completedProjects: worker.completedProjects,
    };
    const saved = this.proposalsRepository.insert(prop);
    if (type === 'invitation') {
      this.notifications.notify(workerId, {
        type: 'invitation',
        text: 'You have been invited to a project',
        subtext: task.title,
        link: '/worker-invitations',
      });
    } else {
      this.notifications.notify(task.clientId, {
        type: 'proposal',
        text: `New proposal from ${worker.name}`,
        subtext: `${task.title}${dto.bidPrice ? ' · bid ' + dto.bidPrice : ''}`,
        link: '/worker-applications',
      });
    }
    return saved;
  }

  /**
   * The edits people actually make: a worker withdraws or revises their own
   * pending bid; the client rejects a pending bid on their project. Status
   * could previously be set to `hired` directly, skipping escrow entirely.
   */
  update(id: string, dto: UpdateProposalDto, actor: Actor) {
    const prop = this.findById(id);
    const task = this.tasksService.findById(prop.taskId);
    const isWorker = prop.workerId === actor.id;
    const isClient = task.clientId === actor.id;
    assertAllowed(isWorker || isClient, 'Only the worker who sent this and the project\'s client can change it.');
    if (prop.status !== 'pending') {
      throw new BadRequestException(`This ${prop.type || 'proposal'} is already ${prop.status}.`);
    }

    const patch: Record<string, any> = {};
    if (isWorker) {
      for (const key of ['bidPrice', 'timeline', 'coverLetter'] as const) {
        if (dto[key] !== undefined) patch[key] = dto[key];
      }
    }
    if (dto.status !== undefined) {
      if (isWorker && dto.status === 'withdrawn') patch.status = 'withdrawn';
      else if (isClient && dto.status === 'rejected') patch.status = 'rejected';
      else {
        throw new BadRequestException(
          'A worker may withdraw their own proposal and a client may reject one. Hiring has its own action.',
        );
      }
    }
    const updated = this.proposalsRepository.update(id, patch);
    if (patch.status === 'rejected') {
      this.notifications.notify(prop.workerId, {
        type: 'proposal',
        text: 'Your proposal was not selected',
        subtext: task.title,
        link: '/my-proposals',
      });
    } else if (patch.status === 'withdrawn' && prop.type !== 'invitation') {
      this.notifications.notify(task.clientId, {
        type: 'proposal',
        text: `${prop.workerName || 'A worker'} withdrew their proposal`,
        subtext: task.title,
        link: '/worker-applications',
      });
    }
    return updated;
  }

  /**
   * Assigns the worker and starts the contract.
   *
   * The budget has been in escrow since the project was posted; hiring is
   * when the contract exists, so it is when the marketplace and initiation
   * fees are charged. Deliberately NOT swallowed: if the client cannot cover
   * the fees, hiring must fail loudly rather than start an unpaid contract.
   */
  private assignAndFund(prop: any) {
    const task = this.tasksService.findById(prop.taskId);
    this.ledger.chargeContractFees(task.id, task.clientId, task.budget, task.title);
    this.tasksService.assignWorker(prop.taskId, prop.workerId);

    // Milestones created before anyone was hired carry no workerId. Without this
    // backfill their payment has no recipient — which used to fail silently and
    // leave the milestone marked paid but the worker uncredited.
    // Any milestone on this task is payable to this task's worker. Checking only
    // for a missing workerId was not enough: a milestone created with someone
    // else's id (the client's, in one case) silently kept it and was paid out
    // to the wrong person.
    for (const ms of this.milestonesService.findAll({ taskId: task.id })) {
      if (ms.workerId !== prop.workerId) {
        this.milestonesService.systemUpdate(ms.id, { workerId: prop.workerId });
      }
    }
  }

  hireWorker(proposalId: string, actor: Actor) {
    const prop = this.findById(proposalId);
    const task = this.openTask(prop.taskId, 'hire workers');
    assertAllowed(task.clientId === actor.id, 'Only the client who owns this project can hire for it.');
    if (prop.type === 'invitation') {
      throw new BadRequestException('An invitation is accepted by the worker, not hired by the client.');
    }
    if (prop.status !== 'pending') {
      throw new BadRequestException(`This proposal is ${prop.status}.`);
    }

    // Fund first: if the client cannot cover the budget plus fees this throws,
    // and no proposal is marked hired for a contract that was never funded.
    this.assignAndFund(prop);

    this.settleOthers(prop, task);
    this.notifications.notify(prop.workerId, {
      type: 'hire',
      text: `You were hired for "${task.title}"`,
      subtext: 'The budget is in escrow — open the milestone board to start',
      link: `/worker-milestone-board?id=${task.id}`,
    });

    return this.proposalsRepository.findById(proposalId);
  }

  /** Marks this proposal hired and every other on the task rejected, telling those workers. */
  private settleOthers(prop: any, task: any) {
    const others = this.proposalsRepository
      .findAll({ taskId: prop.taskId })
      .filter((p: any) => p.id !== prop.id && p.status === 'pending');
    this.proposalsRepository.updateAllByTaskId(prop.taskId, prop.id);
    for (const p of others) {
      this.notifications.notify(p.workerId, {
        type: 'proposal',
        text: p.type === 'invitation' ? 'An invitation is no longer available' : 'Your proposal was not selected',
        subtext: `${task.title} — another worker was hired`,
        link: p.type === 'invitation' ? '/worker-invitations' : '/my-proposals',
      });
    }
  }

  acceptInvitation(proposalId: string, actor: Actor) {
    const prop = this.findById(proposalId);
    if (prop.type !== 'invitation') throw new BadRequestException('This is not an invitation.');
    assertAllowed(prop.workerId === actor.id, 'Only the invited worker can accept this invitation.');
    if (prop.status !== 'pending') {
      throw new BadRequestException(`This invitation is ${prop.status}.`);
    }
    const task = this.openTask(prop.taskId, 'accept invitation');

    this.assignAndFund(prop);
    this.settleOthers(prop, task);
    this.notifications.notify(task.clientId, {
      type: 'hire',
      text: `${prop.workerName || 'The worker'} accepted your invitation`,
      subtext: `${task.title} is now in progress`,
      link: `/project-milestone-board?id=${task.id}`,
    });

    return this.proposalsRepository.findById(proposalId);
  }

  declineInvitation(proposalId: string, actor: Actor) {
    const prop = this.findById(proposalId);
    if (prop.type !== 'invitation') throw new BadRequestException('This is not an invitation.');
    assertAllowed(prop.workerId === actor.id, 'Only the invited worker can decline this invitation.');
    if (prop.status !== 'pending') {
      throw new BadRequestException(`This invitation is already ${prop.status}.`);
    }
    prop.status = 'rejected';
    const task = this.tasksService.findById(prop.taskId);
    this.notifications.notify(task.clientId, {
      type: 'proposal',
      text: `${prop.workerName || 'The worker'} declined your invitation`,
      subtext: task.title,
      link: '/hire-gig-workers',
    });
    return prop;
  }

  resetToSeed() {
    this.proposalsRepository.resetToSeed();
  }
}
