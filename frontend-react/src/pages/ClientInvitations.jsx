/**
 * LANNENT — ClientInvitations
 *
 * The invitations a client has sent. There is no bidding: an invitation is
 * an offer at the project's posted budget, and the worker accepts or
 * declines it. Any worker may also accept the open project directly — the
 * first to accept is hired, and every other invitation on it closes.
 * A pending invitation can be withdrawn here.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import DashboardLayout from '../components/DashboardLayout';
import FilterTabs from '../components/FilterTabs';
import Icon from '../components/Icon';
import StatCard from '../components/StatCard';
import { useAuth } from '../context/AuthContext';
import { useStore } from '../context/StoreContext';
import { useValidation } from '../context/ValidationContext';
import useRerender from '../hooks/useRerender';
import usePageTitle from '../hooks/usePageTitle';

const FILTERS = [['all', 'All'], ['pending', 'Pending'], ['hired', 'Accepted'], ['declined', 'Declined'], ['closed', 'Closed']];
const LABELS = { pending: 'Pending', hired: 'Accepted', declined: 'Declined', withdrawn: 'Withdrawn', closed: 'Closed' };
const BADGES = { pending: 'badge-orange', hired: 'badge-green', declined: 'badge-red', withdrawn: 'badge-gray', closed: 'badge-gray' };

export default function ClientInvitations() {
  const Store = useStore();
  const Auth = useAuth();
  const Validate = useValidation();
  usePageTitle('Sent Invitations — Lannent');
  const rerender = useRerender();
  const [filter, setFilter] = useState('all');
  const userId = Auth.getCurrentUser()?.userId;

  const myTaskIds = new Set(Store.getTasksByClient(userId).map(t => t.id));
  const invitations = Store.getInvitations()
    .filter(p => myTaskIds.has(p.taskId))
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  // Withdrawn ones sit under "Closed" — the worker can no longer accept either way.
  const bucket = p => (p.status === 'withdrawn' ? 'closed' : p.status);
  const list = filter === 'all' ? invitations : invitations.filter(p => bucket(p) === filter);
  const count = key => invitations.filter(p => bucket(p) === key).length;

  function withdraw(p) {
    Validate.confirm(`Withdraw the invitation to ${p.workerName || 'this worker'}? They will be told.`, () => {
      try {
        Store.withdrawInvitation(p.id);
      } catch (e) {
        Validate.toast(e.message, 'error');
        return;
      }
      Validate.toast('Invitation withdrawn.', 'success');
      rerender();
    });
  }

  return (
    <DashboardLayout role="client" activePath="/sent-invitations" pageTitle="Sent Invitations" pageSubtitle="Workers you invited, at your posted budget">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 16, marginBottom: 24 }}>
        <StatCard value={invitations.length} label="Sent" icon="mail" iconBg="#eef2ff" iconColor="#6366f1" />
        <StatCard value={count('pending')} label="Awaiting reply" icon="clock" iconBg="#fff7ed" iconColor="#f97316" />
        <StatCard value={count('hired')} valueStyle={{ color: '#10b981' }} label="Accepted" icon="check-circle" iconBg="#ecfdf5" iconColor="#10b981" />
        <StatCard value={count('declined')} label="Declined" icon="x-circle" iconBg="#fee2e2" iconColor="#ef4444" />
      </div>

      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden' }}>
        <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <FilterTabs tabs={FILTERS} active={filter} onChange={setFilter} />
          <Link to="/hire-gig-workers" className="btn-primary" style={{ fontSize: 13, padding: '8px 16px', borderRadius: 10, textDecoration: 'none' }}>Invite a worker</Link>
        </div>
        {!list.length ? (
          <div style={{ padding: '64px 32px', textAlign: 'center', color: 'var(--muted-foreground)' }}>
            <Icon name="mail-open" style={{ width: 22, height: 22, marginBottom: 12 }} />
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>No invitations here</div>
            <div style={{ fontSize: 14 }}>Invite workers from Hire Workers. Any worker can also accept your open project directly.</div>
          </div>
        ) : list.map(p => {
          const task = Store.getTaskById(p.taskId);
          return (
            <div key={p.id} style={{ padding: '18px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ width: 40, height: 40, borderRadius: '50%', background: p.avatarColor || '#6366f1', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>{p.avatar || '?'}</div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
                  <span style={{ fontWeight: 600, fontSize: 15 }}>{p.workerName || 'Worker'}</span>
                  <span className={`badge ${BADGES[p.status] || 'badge-gray'}`}>{LABELS[p.status] || p.status}</span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>
                  {`${task ? task.title : 'Project'} · ₹${Number(task?.budget || 0).toLocaleString('en-IN')} · sent ${p.createdAt || ''}`}
                  {p.closedReason ? ` · ${p.closedReason}` : ''}
                </div>
              </div>
              {p.status === 'pending' ? (
                <button className="btn-outline" style={{ fontSize: 13, padding: '8px 16px', borderRadius: 10, color: '#ef4444', borderColor: '#fecaca' }} onClick={() => withdraw(p)}>Withdraw</button>
              ) : p.status === 'hired' ? (
                <Link to={`/project-milestone-board?id=${p.taskId}`} className="btn-outline" style={{ fontSize: 13, padding: '8px 16px', borderRadius: 10, textDecoration: 'none' }}>Open project</Link>
              ) : null}
            </div>
          );
        })}
      </div>
    </DashboardLayout>
  );
}
