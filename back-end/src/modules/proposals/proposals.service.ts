import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { UpdateProposalDto } from './dto/update-proposal.dto';
import { ProposalsRepository } from './proposals.repository';
import { TasksService } from '../tasks/tasks.service';
import { LedgerService } from '../ledger/ledger.service';
import { MilestonesService } from '../milestones/milestones.service';
import { UsersService } from '../users/users.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Actor } from '../../common/decorators/actor.decorator';
import { assertAllowed, canViewAnyRecord } from '../../common/guards/viewer.util';
import { ROLES } from '../../common/constants/roles';
import { round2 } from '../ledger/fee-config';

/**
 * ProposalsService — Business Logic Layer
 *
 * There is no bidding. The client sets the price when they post the project
 * (the budget, already in escrow) and a worker can only take it or leave it:
 *   - any active worker may accept an open project; the first to accept is
 *     hired on the spot at the posted budget;
 *   - a client may invite a particular worker, who accepts or declines.
 *     Accepting an invitation is the same as accepting the project.
 * The records kept here are those invitations. Accepting directly needs no
 * record: the project itself carries the hired worker.
 */
@Injectable()
export class ProposalsService {
  constructor(
    private readonly proposalsRepository: ProposalsRepository,
    @Inject(forwardRef(() => TasksService)) private tasksService: TasksService,
    @Inject(forwardRef(() => LedgerService)) private ledger: LedgerService,
    @Inject(forwardRef(() => MilestonesService)) private milestonesService: MilestonesService,
    @Inject(forwardRef(() => UsersService)) private users: UsersService,
    @Inject(forwardRef(() => NotificationsService)) private notifications: NotificationsService,
  ) {}

  /**
   * Internal callers get every row. A worker sees the invitations sent to
   * them; a client sees the ones on their own projects. Nobody else sees any.
   */
  findAll(query?: { taskId?: string; workerId?: string }, viewer?: { id?: string; role?: string }) {
    const all = this.proposalsRepository.findAll(query);
    if (!viewer || canViewAnyRecord(viewer.role)) return all;
    const ownerOf: Record<string, string | null> = {};
    return all.filter((p: any) => {
      if (p.workerId === viewer.id) return true;
      if (!(p.taskId in ownerOf)) ownerOf[p.taskId] = this.safeTask(p.taskId)?.clientId ?? null;
      return ownerOf[p.taskId] === viewer.id;
    });
  }

  findById(id: string, viewer?: { id?: string; role?: string }) {
    const prop = this.proposalsRepository.findById(id);
    if (!prop) throw new NotFoundException(`Invitation with id "${id}" not found`);
    if (viewer && !canViewAnyRecord(viewer.role) && prop.workerId !== viewer.id) {
      const task = this.tasksService.findById(prop.taskId);
      if (task.clientId !== viewer.id) throw new NotFoundException(`Invitation with id "${id}" not found`);
    }
    return prop;
  }

  /** A project closed before anyone accepted it: its pending invitations close with it. */
  closeAllForTask(taskId: string) {
    for (const p of this.proposalsRepository.findAll({ taskId })) {
      if (p.status === 'pending') {
        this.proposalsRepository.update(p.id, { status: 'closed', closedReason: 'The project was closed' });
        this.notifications.notify(p.workerId, {
          type: 'invitation',
          text: 'An invitation was withdrawn',
          subtext: this.titleOf(taskId),
          link: '/worker-invitations',
        });
      }
    }
  }

  /** A worker who can no longer work (suspended, removed): their pending invitations close. */
  closeAllForWorker(workerId: string, why: string) {
    for (const p of this.proposalsRepository.findAll({ workerId })) {
      if (p.status !== 'pending') continue;
      this.proposalsRepository.update(p.id, { status: 'closed', closedReason: why });
      const task = this.safeTask(p.taskId);
      if (task) {
        this.notifications.notify(task.clientId, {
          type: 'invitation',
          text: `Your invitation on "${task.title}" was closed`,
          subtext: why,
          link: '/hire-gig-workers',
        });
      }
    }
  }

  private safeTask(taskId: string) {
    try { return this.tasksService.findById(taskId); } catch { return null; }
  }

  private safeUser(id: string) {
    try { return this.users.findById(id); } catch { return null; }
  }

  private titleOf(taskId: string) {
    return this.safeTask(taskId)?.title || 'Project';
  }

  /** The task, refusing anything that is not open. */
  private openTask(taskId: string, what: string) {
    const task = this.tasksService.findById(taskId);
    if (task.status !== 'open') {
      throw new BadRequestException(`This project is not open — cannot ${what}.`);
    }
    return task;
  }

  /** A client invites a worker to their own open project, at its posted budget. */
  create(dto: CreateProposalDto, actor: Actor) {
    const task = this.openTask(dto.taskId, 'send invitations');
    assertAllowed(task.clientId === actor.id, 'You can only invite workers to your own projects.');

    const worker = this.users.findById(dto.workerId);
    if (worker.role !== ROLES.WORKER || worker.status !== 'active') {
      throw new BadRequestException(`${worker.name} is not an active worker.`);
    }
    const history = this.proposalsRepository.findAll({ taskId: task.id }).filter((p: any) => p.workerId === worker.id);
    if (history.some((p: any) => p.status === 'pending')) {
      throw new BadRequestException(`${worker.name} already has a pending invitation to this project.`);
    }
    // Each invitation notifies the worker, so a declined one is final.
    if (history.some((p: any) => p.status === 'declined')) {
      throw new BadRequestException(`${worker.name} declined this project, so they cannot be invited to it again.`);
    }

    const saved = this.proposalsRepository.insert({
      id: this.proposalsRepository.generateId(),
      taskId: task.id,
      workerId: worker.id,
      type: 'invitation',
      status: 'pending',
      message: (dto.message || '').trim(),
      createdAt: new Date().toISOString().slice(0, 10),
      workerName: worker.name,
      avatar: worker.avatar,
      avatarColor: worker.avatarColor,
    });
    this.notifications.notify(worker.id, {
      type: 'invitation',
      text: 'You have been invited to a project',
      subtext: `${task.title} · ₹${task.budget}`,
      link: '/worker-invitations',
    });
    return saved;
  }

  /** The one edit left: the client withdraws an invitation nobody has answered. */
  update(id: string, dto: UpdateProposalDto, actor: Actor) {
    const prop = this.findById(id);
    const task = this.tasksService.findById(prop.taskId);
    assertAllowed(task.clientId === actor.id, 'Only the client who sent this invitation can withdraw it.');
    if (prop.status !== 'pending') {
      throw new BadRequestException(`This invitation is already ${prop.status}.`);
    }
    if (dto.status !== 'withdrawn') {
      throw new BadRequestException('An invitation can only be withdrawn. The worker accepts or declines it.');
    }
    const updated = this.proposalsRepository.update(id, { status: 'withdrawn' });
    this.notifications.notify(prop.workerId, {
      type: 'invitation',
      text: 'An invitation was withdrawn',
      subtext: task.title,
      link: '/worker-invitations',
    });
    return updated;
  }

  /**
   * Hires the worker at the posted budget and starts the contract.
   *
   * The budget has been in escrow since the project was posted; this is when
   * the contract exists, so it is when the marketplace and initiation fees are
   * charged. The milestones must add up to the budget — that is how the
   * worker is paid — so a project whose client is still reworking the plan
   * cannot be taken. Deliberately NOT swallowed: if the client cannot cover
   * the fees, nobody is hired.
   */
  private hire(task: any, workerId: string) {
    const worker = this.safeUser(workerId);
    if (!worker || worker.role !== ROLES.WORKER || worker.status !== 'active') {
      throw new BadRequestException('Only an active worker account can accept a project.');
    }
    const milestones = this.milestonesService.findAll({ taskId: task.id });
    const price = round2(Number(task.budget));
    const planned = this.milestonesService.totalBudget(task.id);
    if (!milestones.length || planned !== price) {
      throw new BadRequestException(
        `The client is still setting up the milestone plan (it adds up to ₹${planned} of the ₹${price} budget), ` +
          'so this project cannot be accepted yet.',
      );
    }

    try {
      this.ledger.assertCanStartContract(task.id, task.clientId, price);
    } catch (e) {
      if (!(e instanceof BadRequestException)) throw e;
      this.notifications.notify(task.clientId, {
        type: 'hire',
        text: `${worker.name} tried to accept "${task.title}"`,
        subtext: 'Your wallet cannot cover the contract fees — add funds so the project can start',
        link: '/client-wallet',
      });
      throw new BadRequestException('The client cannot fund this contract right now, so it cannot be accepted yet. They have been told.');
    }
    this.ledger.chargeContractFees(task.id, task.clientId, price, task.title);
    this.tasksService.assignWorker(task.id, workerId);

    // Milestones are created before anyone is hired, with no worker on them.
    // Every milestone on this task is payable to this task's worker.
    for (const ms of milestones) {
      if (ms.workerId !== workerId) this.milestonesService.systemUpdate(ms.id, { workerId });
    }

    // Other workers' invitations are no longer available.
    for (const p of this.proposalsRepository.findAll({ taskId: task.id })) {
      if (p.status !== 'pending') continue;
      const mine = p.workerId === workerId;
      this.proposalsRepository.update(p.id, mine ? { status: 'hired' } : { status: 'closed', closedReason: 'Another worker accepted the project' });
      if (!mine) {
        this.notifications.notify(p.workerId, {
          type: 'invitation',
          text: 'An invitation is no longer available',
          subtext: `${task.title} — another worker accepted it`,
          link: '/worker-invitations',
        });
      }
    }
    this.notifications.notify(task.clientId, {
      type: 'hire',
      text: `${worker.name} accepted "${task.title}"`,
      subtext: `The project is in progress at ₹${price}`,
      link: `/project-milestone-board?id=${task.id}`,
    });
    return this.tasksService.findById(task.id);
  }

  /** A worker accepts an open project at its posted budget. The first to accept is hired. */
  acceptProject(taskId: string, actor: Actor) {
    const task = this.openTask(taskId, 'accept it');
    return this.hire(task, actor.id);
  }

  acceptInvitation(proposalId: string, actor: Actor) {
    const prop = this.findById(proposalId);
    assertAllowed(prop.workerId === actor.id, 'Only the invited worker can accept this invitation.');
    if (prop.status !== 'pending') {
      throw new BadRequestException(`This invitation is ${prop.status}.`);
    }
    const task = this.openTask(prop.taskId, 'accept the invitation');
    this.hire(task, actor.id);
    return this.proposalsRepository.findById(proposalId);
  }

  declineInvitation(proposalId: string, actor: Actor) {
    const prop = this.findById(proposalId);
    assertAllowed(prop.workerId === actor.id, 'Only the invited worker can decline this invitation.');
    if (prop.status !== 'pending') {
      throw new BadRequestException(`This invitation is already ${prop.status}.`);
    }
    const updated = this.proposalsRepository.update(proposalId, { status: 'declined' });
    const task = this.tasksService.findById(prop.taskId);
    this.notifications.notify(task.clientId, {
      type: 'invitation',
      text: `${prop.workerName || 'The worker'} declined your invitation`,
      subtext: task.title,
      link: '/hire-gig-workers',
    });
    return updated;
  }

  resetToSeed() {
    this.proposalsRepository.resetToSeed();
  }
}
