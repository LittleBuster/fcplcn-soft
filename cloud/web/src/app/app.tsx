/**
 * @file Композиция облачной панели FCPLCn.
 * Формы, страницы и фоновые процессы разделены; черновики остаются смонтированными при навигации.
 */
import { useRef, useState } from 'preact/hooks';
import type { CloudView } from './types';
import { useCloudSession } from '../hooks/use-cloud-session';
import { useHomeData } from '../hooks/use-home-data';
import { useCloudActions } from '../hooks/use-cloud-actions';
import { useNotice } from '../hooks/use-notice';
import { useConnectionDraft, useAccessDraft } from '../hooks/use-home-drafts';
import { useCloudHistory } from '../hooks/use-cloud-history';
import { useHubPortal } from '../hooks/use-hub-portal';
import { invitationToken, useJoinInvitation } from '../hooks/use-join-invitation';
import { CloudTopbar } from '../components/cloud-topbar';
import { CreateHomeForm } from '../components/create-home-form';
import { JoinInvitation } from '../components/join-invitation';
import { NoticeBanner } from '../components/notice-banner';
import { LoadingPage } from '../pages/loading-page';
import { AuthPage } from '../pages/auth-page';
import { AccountPage } from '../pages/account-page';
import { EmptyHomePage } from '../pages/empty-home-page';
import { HomeWorkspace } from './home-workspace';
import { Icon } from '../icons';
import { failure } from '../lib/presentation';

export function App() {
  const [error, setError] = useState('');
  const [view, setView] = useState<CloudView>('control');
  const [newHome, setNewHome] = useState('');
  const [creating, setCreating] = useState(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const lifetime = { mounted, generation };

  const auth = useCloudSession({
    lifetime,
    onClear: (resetSelection) => data.clear(resetSelection),
    onError: setError,
  });
  const data = useHomeData({
    authenticated: Boolean(auth.session?.authenticated),
    lifetime,
    onError: setError,
  });
  const { notice, setNotice } = useNotice(data.selected);
  const { busy, act } = useCloudActions(data.refresh, setNotice);
  const connection = useConnectionDraft(data.selected, data.detail);
  const access = useAccessDraft(data.selected);
  const history = useCloudHistory(view, data.selected, setNotice);
  const portal = useHubPortal(data.selected, data.selectedRef);
  const invite = invitationToken();
  const { joinInfo, setJoinInfo } = useJoinInvitation(
    Boolean(auth.session?.authenticated),
    invite,
    setNotice,
  );

  const session = auth.session;
  if (!session) {
    return (
      <LoadingPage
        error={error}
        onRetry={() => void auth.refreshSession().catch((error) => setError(failure(error)))}
      />
    );
  }
  if (!session.authenticated) {
    return <AuthPage session={session} invite={invite} onSession={auth.acceptSession} />;
  }

  const home = data.detail?.home || data.homes.find((entry) => entry.id === data.selected);

  return (
    <div class="cloud-app">
      <CloudTopbar
        session={session}
        homes={data.homes}
        selected={data.selected}
        view={view}
        setView={setView}
        onSelectHome={(id) => {
          data.selectHome(id);
          setView('control');
        }}
        onCreateHome={() => setCreating(true)}
        onLogout={auth.logout}
      />
      <main class="cloud-main">
        {creating ? (
          <CreateHomeForm
            newHome={newHome}
            setNewHome={setNewHome}
            setCreating={setCreating}
            busy={busy}
            act={act}
            onCreated={(id) => {
              data.selectHome(id);
              setView('connection');
            }}
          />
        ) : null}
        {joinInfo ? (
          <JoinInvitation
            joinInfo={joinInfo}
            invite={invite}
            busy={busy}
            act={act}
            onAccepted={() => setJoinInfo(null)}
          />
        ) : null}
        {notice ? <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} /> : null}
        {view === 'account' ? (
          <>
            <section class="section-heading">
              <div>
                <span class="eyebrow">Личная учётная запись</span>
                <h1>Профиль и безопасность</h1>
              </div>
              <button class="button secondary" onClick={() => setView('control')}>
                <Icon name="back" />К дому
              </button>
            </section>
            <AccountPage session={session} refresh={auth.refreshSession} />
          </>
        ) : !home ? (
          <EmptyHomePage onCreateHome={() => setCreating(true)} />
        ) : (
          <HomeWorkspace
            home={home}
            session={session}
            data={data}
            view={view}
            setView={setView}
            error={error}
            busy={busy}
            act={act}
            connection={connection}
            access={access}
            portal={portal}
            history={history}
          />
        )}
        <footer class="cloud-footer">
          <span>{session.product.fullName}</span>
          <span>
            <Icon name="shield" />
            Автоматика остаётся дома
          </span>
        </footer>
      </main>
    </div>
  );
}
