import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { UpdateProposalDto } from './dto/update-proposal.dto';
import { ProposalsRepository } from './proposals.repository';
import { TasksService } from '../tasks/tasks.service';
import { TransactionsService } from '../transactions/transactions.service';
import { LedgerService } from '../ledger/ledger.service';
import { MilestonesService } from '../milestones/milestones.service';
import { UsersService } from '../users/users.service';
import { Actor } from '../../common/decorators/actor.decorator';
import { assertAllowed } from '../../common/guards/viewer.util';
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
  ) {}

  findAll(query?: { taskId?: string; workerId?: string; type?: string }) {
    return this.proposalsRepository.findAll(query);
  }

  findById(id: string) {
    const prop = this.proposalsRepository.findById(id);
    if (!prop) throw new NotFoundException(`Proposal with id "${id}" not found`);
    return prop;
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
    return this.proposalsRepository.insert(prop);
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
    return this.proposalsRepository.update(id, patch);
  }

  /**
   * Assigns the worker and funds project escrow through the ledger.
   *
   * The escrow charge is deliberately NOT swallowed: if the client cannot cover
   * the budget plus fees, hiring must fail loudly rather than assign a worker to
   * a project no one has paid for.
   */
  private assignAndFund(prop: any) {
    const task = this.tasksService.findById(prop.taskId);
    this.ledger.fundProjectEscrow(task.id, task.clientId, task.budget, task.title);
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

    // Mark all other proposals for the same task as rejected, this one as hired
    this.proposalsRepository.updateAllByTaskId(prop.taskId, proposalId);

    return this.proposalsRepository.findById(proposalId);
  }

  acceptInvitation(proposalId: string, actor: Actor) {
    const prop = this.findById(proposalId);
    if (prop.type !== 'invitation') throw new BadRequestException('This is not an invitation.');
    assertAllowed(prop.workerId === actor.id, 'Only the invited worker can accept this invitation.');
    if (prop.status !== 'pending') {
      throw new BadRequestException(`This invitation is ${prop.status}.`);
    }
    this.openTask(prop.taskId, 'accept invitation');

    this.assignAndFund(prop);

    this.proposalsRepository.updateAllByTaskId(prop.taskId, proposalId);

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
    return prop;
  }

  resetToSeed() {
    this.proposalsRepository.resetToSeed();
  }
}
