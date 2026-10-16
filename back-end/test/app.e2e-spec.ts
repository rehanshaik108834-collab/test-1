import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';

/**
 * End-to-end checks against the real module graph.
 *
 * The "refused" block replays exploits that worked against the API before
 * ownership checks existed — each one moved money, rewrote someone else's
 * record, or let one user act as another. The "still works" block walks the
 * legitimate flows those checks must not break.
 */
describe('Lannent API (e2e)', () => {
  let app: INestApplication;
  const token: Record<string, string> = {};

  const LOGINS: Record<string, [string, string]> = {
    client: ['client@gmail.com', 'Password@123'], // u1
    bob: ['bob@gmail.com', 'Password@123'], // u8
    worker: ['worker@gmail.com', 'Password@123'], // u2
    sarah: ['sarah@gmail.com', 'Password@123'], // u5, worker on t1
    expert: ['expert@gmail.com', 'Password@123'], // u3
    priya: ['priya@gmail.com', 'Password@123'], // u9
    super: ['super@gmail.com', 'Superadmin@123'], // u4
    revenue: ['admin@gmail.com', 'Admin@123'], // u11
    intake: ['intake@gmail.com', 'Intake@123'], // u12
  };

  const api = () => request(app.getHttpServer());
  let ip = 1;
  const login = (body: any) => api().post('/api/auth/login').set('X-Forwarded-For', `10.0.0.${ip++}`).send(body);
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });
  const get = (who: string, path: string) => api().get('/api' + path).set(as(who));
  const post = (who: string, path: string, body: any = {}) => api().post('/api' + path).set(as(who)).send(body);
  const patch = (who: string, path: string, body: any = {}) => api().patch('/api' + path).set(as(who)).send(body);
  const del = (who: string, path: string) => api().delete('/api' + path).set(as(who));
  const balance = async (id: string) => (await get('super', `/users/${id}`)).body.data.walletBalance;

  /** Payer accepts the reviewer's terms by accepting the pending offer, funds it, and the reviewer takes it on. */
  // Seed milestone m4 (t1, worked by Sarah) is pending; a dispute needs submitted work.
  const submitM4 = () => post('sarah', '/milestones/m4/submit', { deliverable: { title: 'v1' } });
  const engageReviewer = async (payer: string, reviewer: string, arId: string) => {
    const ar = (await get(reviewer, `/audit-requests/${arId}`)).body.data;
    const pending = ar.offers.find((o: any) => o.status === 'pending');
    expect((await post(reviewer, `/audit-requests/${arId}/offers/${pending.id}/accept`)).status).toBe(201);
    expect((await post(payer, `/audit-requests/${arId}/fund`)).status).toBe(201);
    expect((await post(reviewer, `/audit-requests/${arId}/accept`, {})).status).toBe(201);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // The same global setup as main.ts.
    app.setGlobalPrefix('api');
    // Login is limited to 10 a minute per client IP, and this suite signs in
    // more often than that. Each login below comes from its own address.
    (app as any).getHttpAdapter().getInstance().set('trust proxy', true);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    // Logins are rate-limited per IP, so sign in once each.
    for (const [who, [email, password]] of Object.entries(LOGINS)) {
      const res = await login({ email, password });
      expect(res.status).toBe(201);
      token[who] = res.body.data.token;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const res = await post('super', '/seed/reset');
    expect(res.status).toBe(201);
  });

  describe('refused', () => {
    it('ignores a role header without a token', async () => {
      const res = await api().get('/api/users').set('role', 'superuser').set('user-id', 'u4');
      expect(res.status).toBe(401);
    });

    it('does not let a user set their own wallet balance', async () => {
      const before = await balance('u2');
      await patch('worker', '/users/u2', { walletBalance: 999999 });
      expect(await balance('u2')).toBe(before);
    });

    it('does not let a user edit or suspend someone else', async () => {
      expect((await patch('worker', '/users/u8', { status: 'suspended' })).status).toBe(403);
      expect((await patch('worker', '/users/u2', { status: 'suspended' })).status).toBe(403);
      // Project counts are derived, and there is no rating, so a PATCH sets neither.
      await patch('worker', '/users/u2', { rating: 5, completedProjects: 99 });
      const u2 = (await get('worker', '/users/u2')).body.data;
      expect(u2.completedProjects).toBe(0);
      expect(u2.rating).toBeUndefined();
    });

    it('does not wipe fields a PATCH did not send', async () => {
      const res = await patch('client', '/tasks/t1', { title: 'Renamed' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ title: 'Renamed', status: 'in-progress', workerId: 'u5', progress: 75 });
    });

    it('keeps defaults when a create omits optional fields, and owns the task as the caller', async () => {
      const res = await post('client', '/tasks', { title: 'x', description: 'y', category: 'Web Development', budget: 100, clientId: 'u8' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ currency: 'USD', skills: [], auditEnabled: false, clientId: 'u1', status: 'open' });
    });

    it("does not let a client edit, delete or cancel another client's task", async () => {
      expect((await patch('bob', '/tasks/t3', { budget: 1 })).status).toBe(403);
      expect((await del('bob', '/tasks/t3')).status).toBe(403);
    });

    it('does not let a client reassign a worker or force a status', async () => {
      const res = await patch('client', '/tasks/t3', { workerId: 'u2', progress: 100, status: 'completed' });
      expect(res.status).toBe(400);
      const t3 = (await get('client', '/tasks/t3')).body.data;
      expect(t3).toMatchObject({ workerId: null, status: 'open', progress: 0 });
    });

    it('refuses to delete a project that holds escrow', async () => {
      expect((await del('client', '/tasks/t1')).status).toBe(403);
    });

    it("does not let a worker invite themselves onto someone else's project", async () => {
      const before = await balance('u1');
      const prop = await post('worker', '/proposals', { taskId: 't3', workerId: 'u2', type: 'invitation' });
      expect(prop.status).toBe(201);
      expect(prop.body.data.type).toBe('proposal'); // forced: a worker can only bid
      expect((await post('worker', `/proposals/${prop.body.data.id}/accept`)).status).toBe(400);
      expect((await post('worker', `/proposals/${prop.body.data.id}/hire`)).status).toBe(403);
      expect(await balance('u1')).toBe(before);
    });

    it('takes a bid\'s profile figures from the record, not the request', async () => {
      const res = await post('worker', '/proposals', { taskId: 't3', workerId: 'u2', rating: 5, completedProjects: 999 });
      expect(res.body.data.workerName).toBe('Alex Worker');
      expect(res.body.data.rating).toBeUndefined();
      expect(res.body.data.completedProjects).toBeUndefined();
    });

    it("does not let one client hire on another client's project", async () => {
      expect((await post('bob', '/proposals/p1/hire')).status).toBe(403);
    });

    it('does not let a worker repoint, submit or approve milestones that are not theirs', async () => {
      // m3 is on t1, worked by u5 (sarah).
      await patch('worker', '/milestones/m3', { workerId: 'u2' });
      expect((await get('client', '/milestones/m3')).body.data.workerId).toBe('u5');
      expect((await post('worker', '/milestones/m3/submit', { deliverable: { title: 'x' } })).status).toBe(403);
      expect((await post('bob', '/milestones/m3/approve')).status).toBe(403);
    });

    it('resolves a dispute once, and only by its assigned reviewer', async () => {
      await submitM4();
      const d = await post('client', '/disputes', { taskId: 't1', milestoneId: 'm4', reason: 'test', expertId: 'u3', reviewerFee: 150 });
      expect(d.status).toBe(201);
      const id = d.body.data.id;
      const verdict = { verdict: 'client-favour', resolution: 'x' };

      // A verdict before the reviewer's fee is agreed, funded and accepted is refused.
      expect((await post('expert', `/disputes/${id}/resolve`, verdict)).status).toBe(400);
      await engageReviewer('client', 'expert', d.body.data.auditRequestId);

      expect((await post('priya', `/disputes/${id}/resolve`, verdict)).status).toBe(403);
      const before = await balance('u1');
      expect((await post('expert', `/disputes/${id}/resolve`, verdict)).status).toBe(201);
      expect((await post('expert', `/disputes/${id}/resolve`, verdict)).status).toBe(400);
      // Client-favour sends the work back; no money moves.
      expect(await balance('u1')).toBe(before);
    });

    it('raises a dispute as the caller, against the other party', async () => {
      await submitM4();
      const d = await post('client', '/disputes', { taskId: 't1', milestoneId: 'm4', reason: 'r', raisedBy: 'u5', againstId: 'u8', expertId: 'u3', reviewerFee: 100 });
      expect(d.body.data).toMatchObject({ raisedBy: 'u1', againstId: 'u5' });
      expect((await post('bob', '/disputes', { taskId: 't1', milestoneId: 'm3', reason: 'r', expertId: 'u3', reviewerFee: 100 })).status).toBe(403);
    });

    it('does not let a worker raise a dispute', async () => {
      await submitM4();
      expect((await post('sarah', '/disputes', { taskId: 't1', milestoneId: 'm4', reason: 'r', expertId: 'u3', reviewerFee: 100 })).status).toBe(403);
    });

    it('only allows a dispute on submitted work', async () => {
      expect((await post('client', '/disputes', { taskId: 't1', milestoneId: 'm4', reason: 'r', expertId: 'u3', reviewerFee: 100 })).status).toBe(400);
    });

    it('requires a reviewer and a fee to raise a dispute', async () => {
      await submitM4();
      expect((await post('client', '/disputes', { taskId: 't1', milestoneId: 'm4', reason: 'r', expertId: 'u3' })).status).toBe(400);
      expect((await post('client', '/disputes', { taskId: 't1', milestoneId: 'm4', reason: 'r', reviewerFee: 100 })).status).toBe(400);
    });

    it('does not let milestones add up to more than the budget', async () => {
      const task = (await post('client', '/tasks', { title: 'Capped', description: 'd', category: 'Web Development', budget: 500 })).body.data;
      expect((await post('client', '/milestones', { taskId: task.id, title: 'A', budget: 400 })).status).toBe(201);
      expect((await post('client', '/milestones', { taskId: task.id, title: 'B', budget: 200 })).status).toBe(400);
    });

    it('stops honouring the token of a suspended account', async () => {
      expect((await get('worker', '/users/u2')).status).toBe(200);
      expect((await patch('super', '/users/u2', { status: 'suspended' })).status).toBe(200);
      expect((await get('worker', '/users/u2')).status).toBe(401);
      await patch('super', '/users/u2', { status: 'active' });
    });

    it("hides other people's contact details and balances", async () => {
      const other = (await get('worker', '/users/u1')).body.data;
      expect(other.name).toBe('James Client');
      expect(other.email).toBeUndefined();
      expect(other.walletBalance).toBeUndefined();
      expect((await get('worker', '/users/u2')).body.data.walletBalance).toBeDefined();
    });

    it("hides another project's submitted work", async () => {
      // m6 is t2's submitted deliverable; bob has nothing to do with t2.
      expect((await get('bob', '/milestones/m6')).status).toBe(404);
      expect((await get('bob', '/milestones?taskId=t2')).body.data).toHaveLength(0);
      // An open project's plan is visible to a worker deciding whether to bid.
      expect((await get('worker', '/milestones?taskId=t3')).body.data.length).toBe(3);
    });

    it('no longer accepts hand-written transactions, and keeps them private', async () => {
      const res = await post('worker', '/transactions', { type: 'milestone-release', amount: 50000, fromId: 'escrow', toId: 'u2' });
      expect(res.status).toBe(404);
      // u2 works on t6 only: their own rows and t6's, nothing from u1's projects.
      const mine = (await get('worker', '/transactions?userId=u1')).body.data;
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((t: any) => t.fromId === 'u2' || t.toId === 'u2' || t.taskId === 't6')).toBe(true);
      // A client still sees the releases paid out of their own escrow.
      const client = (await get('client', '/transactions')).body.data;
      expect(client.some((t: any) => t.type === 'milestone-release' && t.taskId === 't1')).toBe(true);
    });

    it('works out the side of an audit offer from the caller', async () => {
      const task = await post('client', '/tasks', {
        title: 'audited', description: 'd', category: 'Web Development', budget: 1000,
        auditEnabled: true, auditExpertId: 'u3', auditFee: 100,
      });
      const ar = (await get('expert', `/audit-requests?taskId=${task.body.data.id}`)).body.data[0];
      const offer = await post('expert', `/audit-requests/${ar.id}/offers`, { amount: 9000, offeredBy: 'client' });
      const mine = offer.body.data.offers.at(-1);
      expect(mine.offeredBy).toBe('expert');
      expect((await post('expert', `/audit-requests/${ar.id}/offers/${mine.id}/accept`)).status).toBe(400);
      expect((await post('priya', `/audit-requests/${ar.id}/offers`, { amount: 1 })).status).toBe(403);
      // A reviewer cannot write themselves onto the engagement.
      await patch('priya', `/audit-requests/${ar.id}`, { expertId: 'u9' });
      expect((await get('client', `/audit-requests/${ar.id}`)).body.data.expertId).toBe('u3');
    });

    it('keeps notifications and messages between people who share a project', async () => {
      expect((await post('worker', '/notifications', { userId: 'u1', type: 'x', text: 'phish' })).status).toBe(403);
      const bobs = (await get('bob', '/notifications?userId=u1')).body.data;
      expect(bobs.every((n: any) => n.userId === 'u8')).toBe(true);
      expect((await post('worker', '/messages', { taskId: 't1', senderId: 'u1', receiverId: 'u5', content: 'hi' })).status).toBe(403);
    });

    it('reports draft projects in the revenue summary', async () => {
      await post('client', '/tasks', {
        title: 'd', description: 'd', category: 'Web Development', budget: 100,
        auditEnabled: true, auditExpertId: 'u3', auditFee: 50,
      });
      expect((await get('revenue', '/revenue/summary')).body.data.draftProjects).toBe(1);
    });

    it('applies a fee update completely or not at all', async () => {
      const res = await patch('revenue', '/revenue/fee-config', { depositPercent: 9, workerServicePercents: [20, 10, 500] });
      expect(res.status).toBe(400);
      expect((await get('revenue', '/revenue/fee-config')).body.data.deposit.percent).toBe(2.9);
    });

    it('does not reveal which emails are registered', async () => {
      const a = await login({ email: 'nobody@gmail.com', password: 'x' });
      const b = await login({ email: 'client@gmail.com', password: 'wrong' });
      expect(a.body.message).toBe(b.body.message);
    });
  });

  describe('still works', () => {
    it('runs a project from posting to payout', async () => {
      const task = (await post('bob', '/tasks', { title: 'Landing page', description: 'd', category: 'Web Development', budget: 600 })).body.data;
      const ms = (await post('bob', '/milestones', { taskId: task.id, title: 'Build it', budget: 600 })).body.data;
      const bid = (await post('worker', '/proposals', { taskId: task.id, workerId: 'u2', coverLetter: 'hi' })).body.data;

      const hire = await post('bob', `/proposals/${bid.id}/hire`);
      expect(hire.status).toBe(201);
      expect((await get('bob', `/tasks/${task.id}`)).body.data).toMatchObject({ workerId: 'u2', status: 'in-progress' });

      expect((await patch('worker', `/milestones/${ms.id}`, { status: 'in-progress', progress: 50 })).status).toBe(200);
      expect((await post('worker', `/milestones/${ms.id}/submit`, { deliverable: { title: 'Done' } })).status).toBe(201);

      const before = await balance('u2');
      const approve = await post('bob', `/milestones/${ms.id}/approve`);
      expect(approve.status).toBe(201);
      expect(approve.body.data.release.net).toBeGreaterThan(0);
      expect(await balance('u2')).toBeGreaterThan(before);
      expect((await get('bob', `/tasks/${task.id}`)).body.data).toMatchObject({ status: 'completed', progress: 100 });
    });

    it('lets a client request changes and the worker pick it back up', async () => {
      expect((await patch('client', '/milestones/m6', { status: 'revision-needed' })).status).toBe(200);
    });

    it('lets a client invite a worker and the worker accept', async () => {
      const inv = await post('client', '/proposals', { taskId: 't3', workerId: 'u2', type: 'invitation' });
      expect(inv.body.data.type).toBe('invitation');
      expect((await post('worker', `/proposals/${inv.body.data.id}/accept`)).status).toBe(201);
      expect((await get('client', '/tasks/t3')).body.data.workerId).toBe('u2');
    });

    it('lets a client delete an open project and returns its budget exactly', async () => {
      const before = await balance('u1');
      const task = (await post('client', '/tasks', { title: 'tmp', description: 'd', category: 'Web Development', budget: 1000 })).body.data;
      expect(await balance('u1')).toBe(before - 1000);
      expect((await del('client', `/tasks/${task.id}`)).status).toBe(200);
      expect(await balance('u1')).toBe(before);
    });

    it('refuses to post a project the client cannot pay for', async () => {
      const res = await post('client', '/tasks', { title: 'Too big', description: 'd', category: 'Web Development', budget: 10_000_000 });
      expect(res.status).toBe(400);
      expect((await get('client', '/tasks')).body.data.some((t: any) => t.title === 'Too big')).toBe(false);
    });

    it('holds the budget at posting, charges fees at hire and leaves nothing in escrow at the end', async () => {
      const start = await balance('u8');
      const task = (await post('bob', '/tasks', { title: 'Full cycle', description: 'd', category: 'Web Development', budget: 1000 })).body.data;
      expect(await balance('u8')).toBe(start - 1000);
      expect((await get('bob', `/ledger/escrow/${task.id}`)).body.data.projectHeld).toBe(1000);

      // Milestones use only $900 of the $1,000 budget.
      const ms = (await post('bob', '/milestones', { taskId: task.id, title: 'Only part', budget: 900 })).body.data;
      const bid = (await post('worker', '/proposals', { taskId: task.id, coverLetter: 'hi' })).body.data;
      expect((await post('bob', `/proposals/${bid.id}/hire`)).status).toBe(201);
      expect(await balance('u8')).toBe(Math.round((start - 1000 - 50 - 4.99) * 100) / 100); // fees only

      await post('worker', `/milestones/${ms.id}/submit`, { deliverable: { title: 'Done' } });
      expect((await post('bob', `/milestones/${ms.id}/approve`)).status).toBe(201);
      expect((await get('bob', `/tasks/${task.id}`)).body.data.status).toBe('completed');
      // The unused $100 came back; nothing is left held.
      expect((await get('bob', `/ledger/escrow/${task.id}`)).body.data).toMatchObject({ projectHeld: 0, auditHeld: 0, disputeHeld: 0 });
      expect(await balance('u8')).toBe(Math.round((start - 900 - 54.99) * 100) / 100);
    });

    it('charges a cancellation fee by how long a project was live, and refunds reviewer escrow in full', async () => {
      // t3 was posted weeks ago, so the late rate (5% of $1,200) applies.
      const quote = (await get('client', '/tasks/t3/cancellation-quote')).body.data;
      expect(quote).toMatchObject({ cancellable: true, rate: 5, base: 1200, fee: 60 });
      const before = await balance('u1');
      expect((await patch('client', '/tasks/t3', { status: 'cancelled' })).status).toBe(200);
      expect(await balance('u1')).toBe(before + 1140);
      expect((await get('client', '/ledger/escrow/t3')).body.data.projectHeld).toBe(0);
      expect((await get('revenue', '/revenue/project/t3')).body.data.platformEarnings.cancellationFee).toBe(60);

      // A project cancelled within its first day costs nothing, audit fee included.
      const start = await balance('u1');
      const fresh = (await post('client', '/tasks', {
        title: 'Changed my mind', description: 'd', category: 'Web Development', budget: 500,
        auditEnabled: true, auditExpertId: 'u3', auditFee: 100,
      })).body.data;
      const ar = (await get('expert', `/audit-requests?taskId=${fresh.id}`)).body.data[0];
      await engageReviewer('client', 'expert', ar.id);
      expect((await get('client', `/tasks/${fresh.id}`)).body.data.status).toBe('open');
      expect((await get('client', `/tasks/${fresh.id}/cancellation-quote`)).body.data).toMatchObject({ fee: 0, refund: { audit: 100 } });
      expect((await patch('client', `/tasks/${fresh.id}`, { status: 'cancelled' })).status).toBe(200);
      expect(await balance('u1')).toBe(start);
    });

    it('does not let a client cancel or delete once a worker is hired', async () => {
      expect((await get('client', '/tasks/t1/cancellation-quote')).body.data.cancellable).toBe(false);
      expect((await patch('client', '/tasks/t1', { status: 'cancelled' })).status).toBe(400);
      expect((await del('client', '/tasks/t1')).status).toBe(403);
    });

    it('charges the same fee when a live project is deleted instead of cancelled', async () => {
      const before = await balance('u1');
      expect((await del('client', '/tasks/t3')).status).toBe(200);
      expect(await balance('u1')).toBe(before + 1140);
    });

    it("does not let a superuser move money in or out of someone else's wallet", async () => {
      const before = await balance('u1');
      expect((await post('super', '/users/u1/wallet/add', { amount: 1000 })).status).toBe(403);
      expect((await post('super', '/users/u1/wallet/withdraw', { amount: 100 })).status).toBe(403);
      expect(await balance('u1')).toBe(before);
    });

    it('keeps operations accounts and expert onboarding out of the staff shortcuts', async () => {
      const expert = await post('super', '/users/staff', { name: 'Shortcut Expert', email: 'shortcut@x.com', password: 'Password@123', role: 'expert' });
      expect(expert.status).toBe(400);
      const other = (await post('super', '/users/staff', { name: 'Second Super', email: 'second@x.com', password: 'Password@123', role: 'superuser' })).body.data;
      expect((await del('super', `/users/${other.id}`)).status).toBe(403);
    });

    it('serves live, anonymous platform figures to the landing pages', async () => {
      const res = await api().get('/api/stats/public');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ workers: 4, projectsCompleted: 0 });
      expect(JSON.stringify(res.body.data)).not.toMatch(/@gmail\.com|walletBalance|password/);
    });

    it("does not let a client cut a hired worker's milestone pay", async () => {
      // t1 has Sarah hired; m4 is $200 and pending.
      expect((await patch('client', '/milestones/m4', { budget: 1 })).status).toBe(400);
      expect((await get('client', '/milestones/m4')).body.data.budget).toBe(200);
    });

    it('does not let a superuser approve work or file a report that pays someone', async () => {
      await submitM4();
      expect((await post('super', '/milestones/m4/approve')).status).toBe(403);
      expect((await patch('super', '/milestones/m4', { budget: 1 })).status).toBe(403);
      expect((await post('super', '/audit-reports', { auditRequestId: 'ar1', milestoneId: 'm6', verdict: 'pass' })).status).toBe(403);
    });

    it('does not let a superuser post a project for a client', async () => {
      const res = await post('super', '/tasks', { title: 'On behalf', description: 'd', category: 'Web Development', budget: 100, clientId: 'u1' });
      expect(res.status).toBe(403);
    });

    it('refuses to approve work that was never submitted', async () => {
      expect((await post('client', '/milestones/m4/approve')).status).toBe(400);
    });

    it('pays the dispute reviewer from dispute escrow when they give the verdict', async () => {
      // The client raises the dispute, so the client pays its reviewer.
      await submitM4();
      const d = (await post('client', '/disputes', { taskId: 't1', milestoneId: 'm4', reason: 'Scope mismatch', details: 'More pages were requested.', outcome: 'Release payment', expertId: 'u3', reviewerFee: 120 })).body.data;
      expect(d).toMatchObject({ details: 'More pages were requested.', outcome: 'Release payment', payerId: 'u1' });
      const clientBefore = await balance('u1');
      await engageReviewer('client', 'expert', d.auditRequestId);
      expect(await balance('u1')).toBe(clientBefore - 120);
      expect((await get('client', '/ledger/escrow/t1')).body.data.disputeHeld).toBe(120);

      const expertBefore = await balance('u3');
      const r = await post('expert', `/disputes/${d.id}/resolve`, { verdict: 'worker-favour', resolution: 'Work matches the brief.' });
      expect(r.status).toBe(201);
      expect(await balance('u3')).toBe(expertBefore + 108); // 120 less 10% commission
      expect((await get('sarah', '/ledger/escrow/t1')).body.data.disputeHeld).toBe(0);

      const breakdown = (await get('revenue', '/revenue/project/t1')).body.data;
      expect(breakdown.clientPaid.intoDisputeEscrow).toBe(120);
      expect(breakdown.reviewerDispute.grossFees).toBe(120);
      expect(breakdown.clientPaid.intoAuditEscrow).toBe(0);
    });

    it('sends the milestone back to the worker when the client wins, without moving money', async () => {
      await submitM4();
      const d = (await post('client', '/disputes', { taskId: 't1', milestoneId: 'm4', reason: 'r', expertId: 'u3', reviewerFee: 100 })).body.data;
      await engageReviewer('client', 'expert', d.auditRequestId);
      const held = (await get('client', '/ledger/escrow/t1')).body.data.projectHeld;
      const clientBefore = await balance('u1');
      await post('expert', `/disputes/${d.id}/resolve`, { verdict: 'client-favour', resolution: 'Fix the padding on mobile.' });
      expect((await get('client', '/milestones/m4')).body.data).toMatchObject({ status: 'revision-needed', revisionNote: 'Fix the padding on mobile.' });
      expect((await get('client', '/ledger/escrow/t1')).body.data.projectHeld).toBe(held);
      expect(await balance('u1')).toBe(clientBefore);
      // The worker reworks it and the client can then approve it as usual.
      expect((await post('sarah', '/milestones/m4/submit', { deliverable: { title: 'v2' } })).status).toBe(201);
      expect((await post('client', '/milestones/m4/approve')).status).toBe(201);
    });

    it('accepts only the worker-favour and client-favour verdicts', async () => {
      await submitM4();
      const d = (await post('client', '/disputes', { taskId: 't1', milestoneId: 'm4', reason: 'r', expertId: 'u3', reviewerFee: 100 })).body.data;
      await engageReviewer('client', 'expert', d.auditRequestId);
      for (const verdict of ['split', 'revision']) {
        expect((await post('expert', `/disputes/${d.id}/resolve`, { verdict, resolution: 'x' })).status).toBe(400);
      }
    });

    it('lets operations settle a stuck dispute and returns the reviewer fee', async () => {
      await submitM4();
      const d = (await post('client', '/disputes', { taskId: 't1', milestoneId: 'm4', reason: 'r', expertId: 'u3', reviewerFee: 100 })).body.data;
      await engageReviewer('client', 'expert', d.auditRequestId);
      const before = await balance('u1');
      expect((await post('super', `/disputes/${d.id}/resolve`, { verdict: 'worker-favour', resolution: 'Operations override.' })).status).toBe(201);
      expect(await balance('u1')).toBe(before + 100); // the reviewer fee comes back
      expect((await get('client', '/ledger/escrow/t1')).body.data.disputeHeld).toBe(0);
    });

    it('lets the payer choose another reviewer after a decline', async () => {
      await submitM4();
      const d = (await post('client', '/disputes', { taskId: 't1', milestoneId: 'm4', reason: 'r', expertId: 'u3', reviewerFee: 100 })).body.data;
      await post('expert', `/audit-requests/${d.auditRequestId}/decline`, { reason: 'busy' });
      const next = await post('client', `/audit-requests/${d.auditRequestId}/reassign`, { expertId: 'u9', openingOffer: 90 });
      expect(next.status).toBe(201);
      expect((await get('priya', `/audit-requests/${next.body.data.id}`)).status).toBe(200);
      expect((await get('client', `/disputes/${d.id}`)).body.data.expertId).toBe('u9');
    });

    it('runs an audit engagement from offer to a live project', async () => {
      const task = (await post('client', '/tasks', {
        title: 'Audited', description: 'd', category: 'UI/UX Design', budget: 1000,
        auditEnabled: true, auditExpertId: 'u9', auditFee: 100,
      })).body.data;
      expect(task.status).toBe('draft');
      const ar = (await get('priya', `/audit-requests?taskId=${task.id}`)).body.data[0];
      const counter = (await post('priya', `/audit-requests/${ar.id}/offers`, { amount: 150 })).body.data.offers.at(-1);
      expect((await post('client', `/audit-requests/${ar.id}/offers/${counter.id}/accept`)).status).toBe(201);
      expect((await post('client', `/audit-requests/${ar.id}/fund`)).status).toBe(201);
      expect((await post('priya', `/audit-requests/${ar.id}/accept`, {})).status).toBe(201);
      expect((await get('client', `/tasks/${task.id}`)).body.data.status).toBe('open');
    });

    it('refunds a funded audit when the reviewer declines', async () => {
      const task = (await post('client', '/tasks', {
        title: 'Audited', description: 'd', category: 'UI/UX Design', budget: 1000,
        auditEnabled: true, auditExpertId: 'u9', auditFee: 100,
      })).body.data;
      const ar = (await get('priya', `/audit-requests?taskId=${task.id}`)).body.data[0];
      const opening = ar.offers[0];
      await post('priya', `/audit-requests/${ar.id}/offers/${opening.id}/accept`);
      await post('client', `/audit-requests/${ar.id}/fund`);
      const before = await balance('u1');
      expect((await post('priya', `/audit-requests/${ar.id}/decline`, { reason: 'busy' })).status).toBe(201);
      expect(await balance('u1')).toBe(before + 100);
    });

    it('approves an expert application into a reviewer clients can pick', async () => {
      const app_ = await api().post('/api/expert-applications').send({
        name: 'New Reviewer', email: 'new.rev@gmail.com', password: 'Reviewer@123', expertise: 'Mobile Development',
      });
      expect(app_.status).toBe(201);
      expect((await patch('intake', `/expert-applications/${app_.body.data.id}/status`, { status: 'approved' })).status).toBe(200);
      const signedIn = await login({ email: 'new.rev@gmail.com', password: 'Reviewer@123' });
      expect(signedIn.status).toBe(201);
      expect(signedIn.body.data.user.domains).toContain('Mobile Development');
    });

    it('runs the reported scenario: budget 500, audit 300, dispute 1200 — every fee in escrow, nothing left at the end', async () => {
      const start = await balance('u1');
      const task = (await post('client', '/tasks', {
        title: 'Reported scenario', description: 'd', category: 'Web Development', budget: 500,
        auditEnabled: true, auditExpertId: 'u3', auditFee: 300,
      })).body.data;
      // The project budget is deducted at posting and held.
      expect(await balance('u1')).toBe(start - 500);
      const ms = (await post('client', '/milestones', { taskId: task.id, title: 'Only milestone', budget: 500 })).body.data;

      // Audit fee: agreed, funded into AUDIT escrow, accepted.
      const ar = (await get('expert', `/audit-requests?taskId=${task.id}`)).body.data[0];
      await engageReviewer('client', 'expert', ar.id);
      expect(await balance('u1')).toBe(start - 800);
      let held = (await get('client', `/ledger/escrow/${task.id}`)).body.data;
      expect(held).toMatchObject({ projectHeld: 500, auditHeld: 300, disputeHeld: 0 });

      // Hire: only the contract fees are charged now.
      const bid = (await post('worker', '/proposals', { taskId: task.id, coverLetter: 'hi' })).body.data;
      expect((await post('client', `/proposals/${bid.id}/hire`)).status).toBe(201);
      await post('worker', `/milestones/${ms.id}/submit`, { deliverable: { title: 'v1' } });

      // The client disputes it and offers the reviewer 1200 — funded into DISPUTE escrow.
      const d = (await post('client', '/disputes', { taskId: task.id, milestoneId: ms.id, reason: 'Incomplete work', expertId: 'u3', reviewerFee: 1200 })).body.data;
      await engageReviewer('client', 'expert', d.auditRequestId);
      held = (await get('client', `/ledger/escrow/${task.id}`)).body.data;
      expect(held).toMatchObject({ projectHeld: 500, auditHeld: 300, disputeHeld: 1200 });

      // The reviewer files the milestone audit (releasing the audit fee), then
      // the verdict pays the worker and the reviewer's dispute fee.
      expect((await post('expert', '/audit-reports', { auditRequestId: ar.id, milestoneId: ms.id, verdict: 'pass', findings: 'Clean and complete.' })).status).toBe(201);
      expect((await post('expert', `/disputes/${d.id}/resolve`, { verdict: 'worker-favour', resolution: 'Meets the brief.' })).status).toBe(201);

      expect((await get('client', `/tasks/${task.id}`)).body.data.status).toBe('completed');
      expect((await get('client', `/ledger/escrow/${task.id}`)).body.data).toMatchObject({ projectHeld: 0, auditHeld: 0, disputeHeld: 0 });

      const b = (await get('revenue', `/revenue/project/${task.id}`)).body.data;
      expect(b.clientPaid.intoAuditEscrow).toBe(300);
      expect(b.clientPaid.intoDisputeEscrow).toBe(1200);
      expect(b.reviewerAudit.grossFees).toBe(300);
      expect(b.reviewerDispute.grossFees).toBe(1200);
      expect(b.stillHeld.total).toBe(0);
    });

    it('closes an unfinished audit when the project completes, paying only for what was audited', async () => {
      const start = await balance('u1');
      const task = (await post('client', '/tasks', {
        title: 'Partly audited', description: 'd', category: 'Web Development', budget: 1000,
        auditEnabled: true, auditExpertId: 'u3', auditFee: 400,
      })).body.data;
      const m1 = (await post('client', '/milestones', { taskId: task.id, title: 'One', budget: 500 })).body.data;
      const m2 = (await post('client', '/milestones', { taskId: task.id, title: 'Two', budget: 500 })).body.data;
      const ar = (await get('expert', `/audit-requests?taskId=${task.id}`)).body.data[0];
      await engageReviewer('client', 'expert', ar.id);
      const bid = (await post('worker', '/proposals', { taskId: task.id, coverLetter: 'hi' })).body.data;
      await post('client', `/proposals/${bid.id}/hire`);
      for (const m of [m1, m2]) await post('worker', `/milestones/${m.id}/submit`, { deliverable: { title: 'v1' } });
      // Only the first milestone is audited before the client approves both.
      await post('expert', '/audit-reports', { auditRequestId: ar.id, milestoneId: m1.id, verdict: 'pass', findings: 'Good work here.' });
      const expertBefore = await balance('u3');
      for (const m of [m1, m2]) expect((await post('client', `/milestones/${m.id}/approve`)).status).toBe(201);

      expect((await get('client', `/ledger/escrow/${task.id}`)).body.data).toMatchObject({ projectHeld: 0, auditHeld: 0, disputeHeld: 0 });
      expect(await balance('u3')).toBe(expertBefore + 180); // half of 400, less 10%
      // Client paid 1000 budget + 400 audit + fees, and got the unaudited 200 back.
      expect(await balance('u1')).toBe(Math.round((start - 1000 - 400 - 50 - 4.99 + 200) * 100) / 100);
      expect((await post('expert', '/audit-reports', { auditRequestId: ar.id, milestoneId: m2.id, verdict: 'pass', findings: 'Late report.' })).status).toBe(400);
    });

    it('refuses to hire on a project with no milestones', async () => {
      const task = (await post('client', '/tasks', { title: 'Empty', description: 'd', category: 'Web Development', budget: 300 })).body.data;
      const bid = (await post('worker', '/proposals', { taskId: task.id, coverLetter: 'hi' })).body.data;
      expect((await post('client', `/proposals/${bid.id}/hire`)).status).toBe(400);
    });

    it('names an audit report after the real project, milestone and worker', async () => {
      const task = (await post('client', '/tasks', {
        title: 'Named audit', description: 'd', category: 'Web Development', budget: 600,
        auditEnabled: true, auditExpertId: 'u3', auditFee: 100,
      })).body.data;
      const ms = (await post('client', '/milestones', { taskId: task.id, title: 'Only', budget: 600 })).body.data;
      const ar = (await get('expert', `/audit-requests?taskId=${task.id}`)).body.data[0];
      await engageReviewer('client', 'expert', ar.id);
      const bid = (await post('worker', '/proposals', { taskId: task.id, coverLetter: 'hi' })).body.data;
      await post('client', `/proposals/${bid.id}/hire`);
      await post('worker', `/milestones/${ms.id}/submit`, { deliverable: { title: 'v1' } });
      const report = (await post('expert', '/audit-reports', {
        auditRequestId: ar.id, milestoneId: ms.id, verdict: 'pass', findings: 'Fine.',
        projectTitle: 'Somebody else', milestoneTitle: 'Made up', workerName: 'Nobody',
      })).body.data;
      expect(report).toMatchObject({ projectTitle: 'Named audit', milestoneTitle: 'Only', workerName: 'Alex Worker' });
    });

    it('cancels a draft project for good and returns its money', async () => {
      const start = await balance('u1');
      const task = (await post('client', '/tasks', {
        title: 'Abandoned draft', description: 'd', category: 'Web Development', budget: 700,
        auditEnabled: true, auditExpertId: 'u3', auditFee: 100,
      })).body.data;
      expect(task.status).toBe('draft');
      expect((await post('client', `/tasks/${task.id}/cancel-draft`)).status).toBe(201);
      expect((await get('client', `/tasks/${task.id}`)).body.data.status).toBe('cancelled');
      expect(await balance('u1')).toBe(start);
    });

    it('refuses to delete a user who still has projects or money', async () => {
      expect((await del('super', '/users/u1')).status).toBe(400);
    });

    it('saves every profile field the settings pages send, and changes a password', async () => {
      const res = await patch('worker', '/users/u2', {
        phone: '+919876543210', bio: 'Builds things.', jobTitle: 'React Developer', experienceLevel: 'Senior',
        hourlyRate: 70, availability: 'Part-time', languages: ['English'],
        portfolioProjects: [{ id: 'p1', title: 'Shop', url: 'https://example.com' }],
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ phone: '+919876543210', bio: 'Builds things.', jobTitle: 'React Developer', hourlyRate: 70, availability: 'Part-time' });
      const exp = await patch('expert', '/users/u3', { domains: ['Security'], availability: { status: 'Busy', maxCases: 1, type: 'Audits only' } });
      expect(exp.body.data.domains).toEqual(['Security']);

      expect((await post('worker', '/users/u2/password', { currentPassword: 'wrong', newPassword: 'Another1pass!' })).status).toBe(400);
      expect((await post('worker', '/users/u2/password', { currentPassword: 'Password@123', newPassword: 'Another1pass!' })).status).toBe(201);
      expect((await login({ email: 'worker@gmail.com', password: 'Another1pass!' })).status).toBe(201);
    });

    it('notifies the worker when they are hired', async () => {
      await post('client', '/proposals/p1/hire');
      const notes = (await get('sarah', '/notifications')).body.data;
      expect(notes.some((n: any) => n.type === 'hire' && n.link)).toBe(true);
    });

    it('lets the intake desk open an applicant résumé', async () => {
      const up = await api().post('/api/files/application').attach('file', Buffer.from('%PDF-1.4 test'), { filename: 'cv.pdf', contentType: 'application/pdf' });
      expect(up.status).toBe(201);
      expect((await get('intake', `/files/${up.body.data.id}/meta`)).status).toBe(200);
      expect((await get('worker', `/files/${up.body.data.id}/meta`)).status).toBe(403);
    });

    it("opens a dispute's fee negotiation with the client's proposed fee", async () => {
      await submitM4();
      const d = await post('client', '/disputes', { taskId: 't1', milestoneId: 'm4', reason: 'r', expertId: 'u3', reviewerFee: 150 });
      expect(d.status).toBe(201);
      const pv = await get('expert', `/audit-requests/${d.body.data.auditRequestId}/preview`);
      expect(pv.body.data.kind).toBe('dispute-audit');
      expect(pv.body.data.offers).toEqual([expect.objectContaining({ offeredBy: 'client', amount: 150, status: 'pending' })]);
      // The reviewer can accept it, and the client can then fund it.
      const offerId = pv.body.data.offers[0].id;
      expect((await post('expert', `/audit-requests/${d.body.data.auditRequestId}/offers/${offerId}/accept`)).status).toBe(201);
      expect((await post('client', `/audit-requests/${d.body.data.auditRequestId}/fund`)).status).toBe(201);
    });

    it('delivers messages and notifications within a project', async () => {
      expect((await post('client', '/messages', { taskId: 't1', senderId: 'u1', receiverId: 'u5', content: 'hello' })).status).toBe(201);
      expect((await get('sarah', '/messages?taskId=t1')).body.data).toHaveLength(1);
      expect((await post('client', '/notifications', { userId: 'u5', type: 'x', text: 'ping' })).status).toBe(201);
      expect((await get('sarah', '/notifications')).body.data.length).toBeGreaterThan(0);
    });
  });
});
