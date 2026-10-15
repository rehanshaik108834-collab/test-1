import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { CreateAuditRequestDto } from './dto/create-audit-request.dto';
import { UpdateAuditRequestDto } from './dto/update-audit-request.dto';
import { CreateOfferDto, AcceptAuditDto, DeclineAuditDto } from './dto/audit-offer.dto';
import { AuditRequestsRepository } from './audit-requests.repository';
import { AUDIT_STATUS, AUDIT_KIND, NEGOTIABLE, TERMINAL } from './audit-request.constants';
import { canViewTask, assertCanViewTask, canViewAnyRecord } from '../../common/guards/viewer.util';
import { TasksService } from '../tasks/tasks.service';
import { MilestonesService } from '../milestones/milestones.service';
import { UsersService } from '../users/users.service';
import { DisputesService } from '../disputes/disputes.service';
import { LedgerService } from '../ledger/ledger.service';
import { Actor } from '../../common/decorators/actor.decorator';
import { assertAllowed } from '../../common/guards/viewer.util';
import { ROLES } from '../../common/constants/roles';

/**
 * AuditRequestsService — the Expert Reviewer engagement.
 *
 * An audit is hired, priced and paid here: the expert previews the work before
 * committing, both sides exchange offers until they agree, the client funds the
 * agreed fee into escrow, and the expert is paid from it when the report lands.
 */
@Injectable()
export class AuditRequestsService {
  constructor(
    private readonly auditRequestsRepository: AuditRequestsRepository,
    @Inject(forwardRef(() => TasksService)) private tasks: TasksService,
    @Inject(forwardRef(() => MilestonesService)) private milestones: MilestonesService,
    @Inject(forwardRef(() => UsersService)) private users: UsersService,
    @Inject(forwardRef(() => DisputesService)) private disputes: DisputesService,
    @Inject(forwardRef(() => LedgerService)) private ledger: LedgerService,
  ) {}

  findAll(query?: { expertId?: string; status?: string; taskId?: string; kind?: string },
          viewer?: { id?: string; role?: string }) {
    const all = this.auditRequestsRepository.findAll(query).map((ar: any) => this.withProgress(ar));
    if (!viewer || canViewAnyRecord(viewer.role)) return all;
    // An engagement is only visible to its assigned reviewer and the parties to
    // the work. Previously every reviewer saw every project's audit.
    return all
      .filter((ar: any) =>
        canViewTask(viewer.id, viewer.role, this.taskOf(ar), ar.expertId, ar.clientId, ar.workerId),
      )
      .map((ar: any) => this.withProgress(ar));
  }

  findById(id: string, viewer?: { id?: string; role?: string }) {
    const ar = this.auditRequestsRepository.findById(id);
    if (!ar) throw new NotFoundException(`Audit request with id "${id}" not found`);
    if (viewer) {
      assertCanViewTask(viewer.id, viewer.role, this.taskOf(ar), ar.expertId, ar.clientId, ar.workerId);
    }
    return this.withProgress(ar);
  }

  /** Best-effort task lookup for scoping; a missing task must not throw here. */
  private taskOf(ar: any) {
    return ar?.taskId ? this.safe(() => this.tasks.findById(ar.taskId)) : null;
  }

  create(dto: CreateAuditRequestDto) {
    const { openingOffer, ...rest } = dto;
    // Spread the payload FIRST, then apply defaults. The reverse order — which
    // this codebase uses widely — lets a key that is present but undefined
    // clobber its own default, producing an engagement with no status at all.
    const ar = {
      ...rest,
      id: this.auditRequestsRepository.generateId(),
      kind: dto.kind || AUDIT_KIND.PROJECT,
      status: dto.status || AUDIT_STATUS.PREVIEW_SENT,
      severity: dto.severity || 'Medium',
      createdAt: new Date().toISOString().slice(0, 10),
      expertId: dto.expertId || null,
      disputeId: dto.disputeId || null,
      milestoneId: dto.milestoneId || null,
      workerId: dto.workerId || null,
      agreedAmount: null as number | null,
      offers: [] as any[],
      // Which milestones this engagement has already reported on. An audit is
      // per-milestone even though the engagement is per-project, so this is
      // what stops a milestone being audited twice and what decides when the
      // whole engagement is finished.
      auditedMilestoneIds: [] as string[],
    };
    if (ar.expertId) this.assertAssignableExpert(ar.expertId, dto.category);
    this.auditRequestsRepository.insert(ar);

    // A client can open with a price so experts see a number in their queue.
    if (openingOffer) {
      this.recordOffer(ar, { amount: openingOffer, offeredBy: 'client', note: 'Opening offer' });
    }
    return this.auditRequestsRepository.findById(ar.id);
  }

  /**
   * A client opens an audit on their own project (e.g. "find another
   * reviewer" after a decline). Ownership, the worker and the kind come from
   * the task, not the body: a dispute audit is only ever opened by a dispute.
   */
  createForClient(dto: CreateAuditRequestDto, actor: Actor) {
    const task = this.tasks.findById(dto.taskId);
    assertAllowed(
      task.clientId === actor.id || actor.role === ROLES.SUPERUSER,
      'You can only request an audit of your own project.',
    );
    return this.create({
      taskId: task.id,
      clientId: task.clientId,
      workerId: task.workerId || undefined,
      expertId: dto.expertId,
      milestoneId: dto.milestoneId,
      severity: dto.severity,
      dueDate: dto.dueDate,
      openingOffer: dto.openingOffer,
      project: task.title,
      category: task.category,
      kind: AUDIT_KIND.PROJECT,
    });
  }

  /**
   * Descriptive fields only, by a party to the engagement. This accepted
   * `expertId` from any client or expert, which let a reviewer write
   * themselves onto someone else's funded engagement and then accept it.
   */
  update(id: string, dto: UpdateAuditRequestDto, actor: Actor) {
    const ar = this.findById(id);
    this.sideOf(ar, actor);
    const patch: Record<string, any> = {};
    for (const key of ['severity', 'dueDate', 'project', 'worker', 'milestone'] as const) {
      if (dto[key] !== undefined) patch[key] = dto[key];
    }
    return this.auditRequestsRepository.update(id, patch);
  }

  /** Lifecycle writes the platform makes itself (milestone hand-over). */
  systemUpdate(id: string, partial: Record<string, any>) {
    const updated = this.auditRequestsRepository.update(id, partial);
    if (!updated) throw new NotFoundException(`Audit request with id "${id}" not found`);
    return updated;
  }

  /**
   * Which side of the engagement the caller is on. The offer endpoints took
   * `offeredBy` from the request body, so a reviewer could post an offer
   * "from the client" and then accept it themselves.
   */
  private sideOf(ar: any, actor: Actor): 'client' | 'expert' {
    if (actor.id && actor.id === ar.clientId) return 'client';
    if (actor.id && actor.id === ar.expertId) return 'expert';
    throw new ForbiddenException('Only the client and the assigned reviewer can act on this audit.');
  }

  /**
   * Everything the expert needs to judge the job before accepting it — the
   * project, its milestones, the client, and for a dispute audit the claim
   * itself. Previously an expert accepted with no visibility at all.
   */
  preview(id: string, viewer?: { id?: string; role?: string }) {
    const ar = this.findById(id, viewer);
    const task = this.safe(() => this.tasks.findById(ar.taskId));
    const client = this.safe(() => this.users.findById(ar.clientId));
    const worker = ar.workerId ? this.safe(() => this.users.findById(ar.workerId)) : null;
    const milestones = ar.taskId ? this.safe(() => this.milestones.findAll({ taskId: ar.taskId })) || [] : [];
    const dispute = ar.disputeId ? this.safe(() => this.disputes.findById(ar.disputeId)) : null;
    const focus = ar.milestoneId ? milestones.find((m: any) => m.id === ar.milestoneId) : null;

    return {
      auditRequest: ar,
      kind: ar.kind,
      project: task
        ? {
            id: task.id, title: task.title, description: task.description,
            category: task.category, budget: task.budget, currency: task.currency,
            deadline: task.deadline, skills: task.skills, status: task.status,
            progress: task.progress,
          }
        : null,
      client: client ? { id: client.id, name: client.name, company: client.company, avatar: client.avatar, avatarColor: client.avatarColor } : null,
      worker: worker ? { id: worker.id, name: worker.name, rating: worker.rating, skills: worker.skills, avatar: worker.avatar, avatarColor: worker.avatarColor } : null,
      milestones: milestones.map((m: any) => ({
        id: m.id, title: m.title, description: m.description, budget: m.budget,
        status: m.status, deliverable: m.deliverable,
      })),
      focusMilestone: focus || null,
      dispute: dispute
        ? { id: dispute.id, reason: dispute.reason, raisedByName: dispute.raisedByName, againstName: dispute.againstName, amount: dispute.amount, status: dispute.status }
        : null,
      offers: ar.offers || [],
      agreedAmount: ar.agreedAmount,
    };
  }

  /** Records an offer or counter-offer. Either side may open or counter. */
  addOffer(id: string, dto: CreateOfferDto, actor: Actor) {
    const ar = this.findById(id);
    return this.recordOffer(ar, { ...dto, offeredBy: this.sideOf(ar, actor) });
  }

  private recordOffer(ar: any, dto: { amount: number; offeredBy: string; note?: string }) {
    const id = ar.id;
    this.assertNegotiable(ar);

    // A new offer supersedes any outstanding one.
    (ar.offers || []).forEach((o: any) => {
      if (o.status === 'pending') o.status = 'countered';
    });

    const offer = {
      id: 'of_' + Date.now() + '_' + ((ar.offers?.length || 0) + 1),
      offeredBy: dto.offeredBy,
      amount: dto.amount,
      note: dto.note || '',
      status: 'pending',
      createdAt: new Date().toISOString().slice(0, 10),
    };
    ar.offers = [...(ar.offers || []), offer];
    ar.status = AUDIT_STATUS.NEGOTIATING;
    return this.auditRequestsRepository.update(id, ar);
  }

  /** Accepts an outstanding offer, fixing the fee. The other side must accept. */
  acceptOffer(id: string, offerId: string, actor: Actor) {
    const ar = this.findById(id);
    const acceptedBy = this.sideOf(ar, actor);
    this.assertNegotiable(ar);

    const offer = (ar.offers || []).find((o: any) => o.id === offerId);
    if (!offer) throw new NotFoundException(`Offer "${offerId}" not found on this audit request.`);
    if (offer.status !== 'pending') {
      throw new BadRequestException(`That offer is no longer open (status: ${offer.status}).`);
    }
    if (offer.offeredBy === acceptedBy) {
      throw new BadRequestException('You cannot accept your own offer — wait for the other side.');
    }

    offer.status = 'accepted';
    ar.agreedAmount = offer.amount;
    ar.status = AUDIT_STATUS.AGREED;
    return this.auditRequestsRepository.update(id, ar);
  }

  /** Client moves the agreed fee into escrow. Nothing can start before this. */
  fund(id: string, actor: Actor) {
    const ar = this.findById(id);
    assertAllowed(ar.clientId === actor.id, 'Only the client on this audit can fund it.');
    if (ar.status !== AUDIT_STATUS.AGREED) {
      throw new BadRequestException(
        `Escrow can only be funded once a fee is agreed (current status: ${ar.status}).`,
      );
    }
    if (!ar.agreedAmount) throw new BadRequestException('No agreed amount to fund.');

    this.ledger.fundAuditEscrow(ar.taskId, ar.clientId, ar.agreedAmount, 'technical audit');
    ar.status = AUDIT_STATUS.ESCROW_FUNDED;
    return this.auditRequestsRepository.update(id, ar);
  }

  /**
   * Expert takes the engagement. For a project audit this is what releases the
   * project from draft — the client's project only goes live once an expert has
   * committed and the fee is in escrow.
   */
  accept(id: string, dto: AcceptAuditDto, actor: Actor) {
    const ar = this.findById(id);
    // The reviewer taking the job is the caller. `expertId` in the body was
    // compared to the assignment but never to who was asking, so any expert
    // could accept on the assigned reviewer's behalf. Staff still name one.
    if (actor.role !== ROLES.SUPERUSER) dto = { ...dto, expertId: actor.id };
    if (ar.status !== AUDIT_STATUS.ESCROW_FUNDED) {
      throw new BadRequestException(
        `An audit can only be accepted once its fee is in escrow (current status: ${ar.status}).`,
      );
    }
    if (!dto.expertId) throw new BadRequestException('Name the Expert Reviewer taking this audit.');
    // The payee has to be a real, active reviewer.
    this.assertAssignableExpert(dto.expertId);
    // The reviewer accepting must be the one the client assigned.
    if (ar.expertId && ar.expertId !== dto.expertId) {
      throw new BadRequestException('This audit is assigned to a different Expert Reviewer.');
    }

    ar.expertId = dto.expertId;
    ar.status = AUDIT_STATUS.IN_PROGRESS;
    this.auditRequestsRepository.update(id, ar);

    if (ar.kind === AUDIT_KIND.PROJECT) {
      this.safe(() => this.tasks.publishDraft(ar.taskId));
    }
    return this.auditRequestsRepository.findById(id);
  }

  decline(id: string, dto: DeclineAuditDto, actor: Actor) {
    const ar = this.findById(id);
    assertAllowed(
      actor.role === ROLES.SUPERUSER || (ar.expertId && ar.expertId === actor.id),
      'Only the assigned reviewer can decline this audit.',
    );
    if (TERMINAL.includes(ar.status)) {
      throw new BadRequestException(`This audit is already ${ar.status}.`);
    }
    // A decline after funding used to leave the fee in audit escrow with no
    // reviewer to pay it to and no route to get it back. It goes home.
    let refund: any = null;
    const funded = [AUDIT_STATUS.ESCROW_FUNDED, AUDIT_STATUS.IN_PROGRESS].includes(ar.status as any);
    if (funded && !ar.feePaid && ar.agreedAmount > 0) {
      const held = this.ledger.getEscrow(ar.taskId).auditHeld;
      const amount = Math.min(held, ar.agreedAmount);
      if (amount > 0) {
        refund = this.ledger.refundAuditEscrow({
          taskId: ar.taskId,
          clientId: ar.clientId,
          amount,
          reason: 'Reviewer declined the audit — fee returned',
        });
      }
    }
    ar.refund = refund;
    ar.status = AUDIT_STATUS.DECLINED;
    ar.declineReason = dto.reason || null;
    // Release the assignment so the client can pick someone else.
    ar.declinedBy = ar.expertId;
    ar.expertId = null;
    return this.auditRequestsRepository.update(id, ar);
  }

  /**
   * Called by AuditReportsService once a report is filed. Pays the expert and
   * moves the engagement on.
   *
   * The fee is agreed once for the whole project audit and is released once,
   * when the audit is actually finished — every milestone on the task has a
   * report. Until then it stays in escrow.
   *
   * Before this, the first report both paid the expert in full and closed the
   * engagement, so a four-milestone project showed a finished audit after one
   * milestone and held nothing against the three still unreviewed.
   */
  settle(id: string, milestoneId?: string) {
    const ar = this.auditRequestsRepository.findById(id);
    if (!ar) throw new NotFoundException(`Audit request with id "${id}" not found`);

    const fileable = [
      AUDIT_STATUS.IN_PROGRESS,
      AUDIT_STATUS.REPORT_SUBMITTED,
      // A paid engagement is still open for the milestones it has not covered.
      AUDIT_STATUS.PAID,
    ];
    if (!fileable.includes(ar.status as any)) {
      throw new BadRequestException(
        `A report can only be filed against an audit in progress (current status: ${ar.status}).`,
      );
    }

    // Record coverage before deciding whether the engagement is finished.
    this.recordMilestoneAudited(id, milestoneId);
    const fresh = this.auditRequestsRepository.findById(id);

    const progress = this.auditProgress(fresh);
    // A dispute audit covers the one claim it was raised for, so it finishes
    // with its report. A project audit finishes only when nothing is left.
    const finished = fresh.kind !== AUDIT_KIND.PROJECT || !progress || progress.complete;

    if (!finished) {
      // The fee stays in escrow. It buys the whole project audit, so paying it
      // out after the first of four reports would leave the client with nothing
      // held while three milestones were still unreviewed.
      this.auditRequestsRepository.update(id, {
        ...fresh,
        status: AUDIT_STATUS.IN_PROGRESS,
      });
      return {
        auditRequest: this.withProgress(this.auditRequestsRepository.findById(id)),
        payout: {
          pending: true,
          reason: 'The audit fee is released once every milestone has a report.',
          audited: progress.audited,
          total: progress.total,
          remaining: progress.pendingMilestoneIds,
        },
      };
    }

    const firstPayout = !fresh.feePaid;
    const payout = this.ledger.releaseAuditFee({
      auditRequestId: fresh.id,
      taskId: fresh.taskId,
      expertId: fresh.expertId,
      amount: fresh.agreedAmount,
    });
    fresh.feePaid = true;
    fresh.paidAt = fresh.paidAt || new Date().toISOString().slice(0, 10);
    fresh.status = AUDIT_STATUS.PAID;
    this.auditRequestsRepository.update(id, fresh);

    // Credit the expert's review count — once per engagement, not per report.
    if (firstPayout) {
      this.safe(() => {
        const expert = this.users.findById(fresh.expertId);
        this.users.update(fresh.expertId, { reviewsDone: (expert?.reviewsDone || 0) + 1 });
      });
    }

    return { auditRequest: this.withProgress(this.auditRequestsRepository.findById(id)), payout };
  }

  // ── Per-milestone audit progress ──────────────────────────────────────────

  /**
   * How far through the project this engagement is.
   *
   * The engagement is priced and paid once for the whole project, but the work
   * is done milestone by milestone. Filing the first report used to end the
   * engagement, which showed the client and the reviewer a "Completed" audit
   * while later milestones had never been looked at. Completion is now a fact
   * about coverage: every milestone on the task has a report.
   */
  auditProgress(ar: any) {
    if (!ar || ar.kind !== AUDIT_KIND.PROJECT) return null;
    const milestones = ar.taskId
      ? this.safe(() => this.milestones.findAll({ taskId: ar.taskId })) || []
      : [];
    const audited: string[] = ar.auditedMilestoneIds || [];

    const auditedIds = milestones.filter((m: any) => audited.includes(m.id)).map((m: any) => m.id);
    const pending = milestones.filter((m: any) => !audited.includes(m.id));
    // Submitted and waiting on the reviewer, versus not yet handed over at all.
    const awaitingReview = pending.filter((m: any) =>
      ['submitted', 'review', 'disputed'].includes(m.status),
    );

    return {
      total: milestones.length,
      audited: auditedIds.length,
      auditedMilestoneIds: auditedIds,
      awaitingReview: awaitingReview.length,
      awaitingReviewMilestoneIds: awaitingReview.map((m: any) => m.id),
      pendingMilestoneIds: pending.map((m: any) => m.id),
      // No milestones means nothing left to audit, rather than never finished —
      // otherwise the fee could never be released.
      complete: pending.length === 0,
    };
  }

  /** Read shape: the stored row plus its computed coverage. */
  private withProgress(ar: any) {
    if (!ar) return ar;
    const progress = this.auditProgress(ar);
    return progress ? { ...ar, auditProgress: progress } : ar;
  }

  /** True once a report has been filed for this milestone under this engagement. */
  isMilestoneAudited(ar: any, milestoneId?: string): boolean {
    if (!ar || !milestoneId) return false;
    return (ar.auditedMilestoneIds || []).includes(milestoneId);
  }

  /**
   * Records that a milestone has been reported on. Called when a report is
   * filed; idempotent, so re-filing the same report does not double-count.
   */
  recordMilestoneAudited(id: string, milestoneId?: string) {
    if (!milestoneId) return null;
    const ar = this.auditRequestsRepository.findById(id);
    if (!ar) return null;
    const audited: string[] = ar.auditedMilestoneIds || [];
    if (!audited.includes(milestoneId)) {
      ar.auditedMilestoneIds = [...audited, milestoneId];
      this.auditRequestsRepository.update(id, ar);
    }
    return this.auditRequestsRepository.findById(id);
  }

  /**
   * The live project audit for a task, if there is one. An engagement stays
   * live after it has been paid while milestones remain unaudited — the fee
   * covers the project, not the first milestone that happens to arrive.
   */
  activeProjectAudit(taskId: string) {
    const candidates = this.auditRequestsRepository
      .findAll({ taskId, kind: AUDIT_KIND.PROJECT })
      .filter((a: any) => ![AUDIT_STATUS.DECLINED, AUDIT_STATUS.CANCELLED].includes(a.status));
    // An engagement an expert has actually taken on comes first.
    return (
      candidates.find((a: any) => a.expertId && !this.auditProgress(a)?.complete) ||
      candidates.find((a: any) => a.expertId) ||
      null
    );
  }

  /**
   * A reviewer must exist, be an expert, and be active. When a category is
   * given, their domains must cover it — the client only ever sees
   * domain-matched reviewers, so a mismatch means a tampered request.
   */
  assertAssignableExpert(expertId: string, category?: string) {
    const expert = this.safe(() => this.users.findById(expertId));
    if (!expert) throw new BadRequestException(`No user found with id "${expertId}".`);
    if (expert.role !== 'expert') throw new BadRequestException(`${expert.name} is not an Expert Reviewer.`);
    if (expert.status !== 'active') throw new BadRequestException(`${expert.name}'s account is not active.`);
    if (category && Array.isArray(expert.domains) && expert.domains.length
        && !expert.domains.includes(category)) {
      throw new BadRequestException(`${expert.name} does not review ${category} work.`);
    }
    return expert;
  }

  private assertNegotiable(ar: any) {
    if (!NEGOTIABLE.includes(ar.status)) {
      throw new BadRequestException(
        `Offers can only be exchanged while negotiating (current status: ${ar.status}).`,
      );
    }
  }

  /** Cross-module reads are best-effort — a missing task must not break a preview. */
  private safe<T>(fn: () => T): T | null {
    try { return fn(); } catch { return null; }
  }

  resetToSeed() {
    this.auditRequestsRepository.resetToSeed();
  }
}
