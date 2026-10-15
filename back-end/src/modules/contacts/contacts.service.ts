import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { TasksService } from '../tasks/tasks.service';
import { ProposalsService } from '../proposals/proposals.service';
import { AuditRequestsService } from '../audit-requests/audit-requests.service';
import { DisputesService } from '../disputes/disputes.service';

/**
 * Who is connected to whom, through the work.
 *
 * Messages and notifications were open to any signed-in user addressed to any
 * other — a worker could drop "your account is locked, send me your password"
 * into a stranger's notifications. A person may now only reach someone they
 * share a project with: its client and worker, anyone bidding on or invited
 * to it, and the reviewers on its audits and disputes.
 */
@Injectable()
export class ContactsService {
  constructor(
    @Inject(forwardRef(() => TasksService)) private readonly tasks: TasksService,
    @Inject(forwardRef(() => ProposalsService)) private readonly proposals: ProposalsService,
    @Inject(forwardRef(() => AuditRequestsService)) private readonly auditRequests: AuditRequestsService,
    @Inject(forwardRef(() => DisputesService)) private readonly disputes: DisputesService,
  ) {}

  /** Everyone attached to one task. */
  participantsOf(taskId: string): Set<string> {
    const people = new Set<string>();
    const add = (id?: string | null) => { if (id) people.add(id); };

    const task = this.tasks.findAll({}, 'system').find((t: any) => t.id === taskId);
    if (!task) return people;
    add(task.clientId);
    add(task.workerId);
    for (const p of this.proposals.findAll({ taskId })) add(p.workerId);
    for (const a of this.auditRequests.findAll({ taskId })) add(a.expertId);
    for (const d of this.disputes.findAll()) if (d.taskId === taskId) add(d.expertId);
    return people;
  }

  isParticipant(userId: string, taskId: string): boolean {
    return !!userId && this.participantsOf(taskId).has(userId);
  }

  /** True when the two people appear together on at least one task. */
  shareTask(a: string, b: string): boolean {
    if (!a || !b) return false;
    return this.tasks
      .findAll({}, 'system')
      .some((t: any) => {
        const people = this.participantsOf(t.id);
        return people.has(a) && people.has(b);
      });
  }
}
