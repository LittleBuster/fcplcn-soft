/** @file Компоновка разделов выбранного дома; формы и фоновые процессы живут в своих модулях. */
import type { HomeDataModel, CloudView, CloudAction } from './types';
import type { CloudSession, HomeView } from '../../../shared/api.js';
import type { useConnectionDraft, useAccessDraft } from '../hooks/use-home-drafts';
import type { useHubPortal } from '../hooks/use-hub-portal';
import type { useCloudHistory } from '../hooks/use-cloud-history';
import { HomeNavigation } from '../components/home-navigation';
import { AccessPage } from '../pages/access-page';
import { ConnectionPage } from '../pages/connection-page';
import { ControlPage } from '../pages/control-page';
import { HistoryPage } from '../pages/history-page';
import { CloudFirmwarePanel } from '../firmware';
import { Icon } from '../icons';

interface HomeWorkspaceProps {
  home: HomeView;
  session: CloudSession;
  data: HomeDataModel;
  view: CloudView;
  setView: (view: CloudView) => void;
  error: string;
  busy: boolean;
  act: CloudAction;
  connection: ReturnType<typeof useConnectionDraft>;
  access: ReturnType<typeof useAccessDraft>;
  portal: ReturnType<typeof useHubPortal>;
  history: ReturnType<typeof useCloudHistory>;
}

export function HomeWorkspace({
  home,
  session,
  data,
  view,
  setView,
  error,
  busy,
  act,
  connection,
  access,
  portal,
  history,
}: HomeWorkspaceProps) {
  const owner = home.role === 'owner';
  const activeHub = data.detail?.hubs.find((entry) => !entry.revoked);

  return (
    <>
      <HomeNavigation
        home={home}
        activeHub={activeHub}
        owner={owner}
        online={activeHub?.online === true}
        view={view}
        setView={setView}
      />
      {error ? (
        <div class="notice warning" role="status">
          <Icon name="refresh" />
          {error}
          <button class="text-button" onClick={() => void data.refresh()}>
            Обновить
          </button>
        </div>
      ) : null}
      {view === 'control' ? (
        <ControlPage
          home={home}
          activeHub={activeHub}
          frame={portal.frame}
          height={portal.height}
          onConnect={() => setView('connection')}
        />
      ) : null}
      {view === 'connection' ? (
        <ConnectionPage
          home={home}
          detail={data.detail}
          owner={owner}
          activeHub={activeHub}
          busy={busy}
          act={act}
          draft={connection}
        />
      ) : null}
      {view === 'access' && owner ? (
        <AccessPage
          home={home}
          detail={data.detail}
          owner={owner}
          busy={busy}
          act={act}
          refresh={data.refresh}
          draft={access}
        />
      ) : null}
      {view === 'firmware' && owner && data.selected ? (
        <CloudFirmwarePanel
          key={data.selected}
          homeId={data.selected}
          csrfToken={session.csrfToken}
        />
      ) : null}
      {view === 'history' ? <HistoryPage history={history} /> : null}
    </>
  );
}
