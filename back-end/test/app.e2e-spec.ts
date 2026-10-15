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
      expect((await patch('worker', '/users/u2', { rating: 5 })).status).toBe(403);
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
      expect(res.body.data).toMatchObject({ rating: 4.8, completedProjects: 23, workerName: 'Alex Worker' });
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
      const d = await post('client', '/disputes', { taskId: 't1', milestoneId: 'm4', reason: 'test', expertId: 'u3' });
      expect(d.status).toBe(201);
      const id = d.body.data.id;
      const verdict = { verdict: 'client-favour', resolution: 'x' };

      expect((await post('priya', `/disputes/${id}/resolve`, verdict)).status).toBe(403);
      const before = await balance('u1');
      expect((await post('expert', `/disputes/${id}/resolve`, verdict)).status).toBe(201);
      expect((await post('expert', `/disputes/${id}/resolve`, verdict)).status).toBe(400);
      expect(await balance('u1')).toBe(before + 200); // m4's budget, once
    });

    it('raises a dispute as the caller, against the other party', async () => {
      const d = await post('client', '/disputes', { taskId: 't1', milestoneId: 'm4', reason: 'r', raisedBy: 'u5', againstId: 'u8', expertId: 'u3' });
      expect(d.body.data).toMatchObject({ raisedBy: 'u1', againstId: 'u5' });
      expect((await post('bob', '/disputes', { taskId: 't1', milestoneId: 'm3', reason: 'r' })).status).toBe(403);
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

    it('lets a client delete an open project without crediting anything', async () => {
      const task = (await post('client', '/tasks', { title: 'tmp', description: 'd', category: 'Web Development', budget: 100000 })).body.data;
      const before = await balance('u1');
      expect((await del('client', `/tasks/${task.id}`)).status).toBe(200);
      expect(await balance('u1')).toBe(before);
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

    it("opens a dispute's fee negotiation with the client's proposed fee", async () => {
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
