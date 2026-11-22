/** @file Сборка локальной панели хаба и того же интерфейса в облачном портале. */
import { useHubSession } from '../hooks/use-hub-session';
import { useHubSnapshot } from '../hooks/use-hub-snapshot';
import { useHubNotices } from '../hooks/use-hub-notices';
import { useHubNavigation } from '../hooks/use-hub-navigation';
import { useHubCommands } from '../hooks/use-hub-commands';
import { useHubScenes } from '../hooks/use-hub-scenes';
import { usePortalHeight } from '../hooks/use-portal-height';
import { DevicesPage } from '../pages/devices';
import { PultPage } from '../pages/pult';
import { ScenesPanel } from '../scenes';
import { DevicePage } from '../pages/device';
import { TelegramPanel } from '../telegram';
import { CloudPanel } from '../cloud';
import { AccountPanel } from '../account';
import { HouseSecurityStatus } from '../house-security';
import { ActivityPage } from '../pages/activity';
import { StartupPage } from '../pages/startup';
import { Login } from '../auth/login';
import { HubLayout } from './layout';
import { PageHeading } from './page-heading';
import { ActionNotice, ConnectionNotice } from './notices';
import { Icon } from '../icons';
import { canControl, portal } from '../portal';

/** Соединяет страницы и хуки; автоматизация и MQTT выполняются независимо от браузера. */
export function App() {
  usePortalHeight();
  const navigation = useHubNavigation(() => notices.setNotice(null));

  // Сброс интерфейса идёт до ожидания ответа logout, чтобы старые данные сразу закрылись.
  const auth = useHubSession(() => {
    notices.setNotice(null);
    commands.setPending(new Set());
    commands.setSceneStarting(false);
    data.setSnapshot(null);
    navigation.setSelectedId(null);
    navigation.setConfiguringId(null);
  });
  const data = useHubSnapshot(auth, () => {
    navigation.setConfiguringId(null);
    commands.setSceneStarting(false);
    commands.setPending(new Set());
  });
  const notices = useHubNotices(data.snapshot?.scenes.runs[0]?.id);
  const commands = useHubCommands(auth, data, notices);
  const scenes = useHubScenes(data);

  const { session, initialError, loadSession, loginUsername, logout } = auth;
  const { snapshot, loadError, refreshing, refresh } = data;
  const { view, selectedId, configuringId, navigate } = navigation;
  const devices = snapshot?.devices || [];
  const selected = devices.find((device) => device.id === selectedId);
  const brokerConnected = Boolean(snapshot?.broker.connected && !loadError && data.connectionFresh);
  const clearNotice = () => notices.setNotice(null);

  if (!session) return <StartupPage initialError={initialError} loadSession={loadSession} />;
  if (!session.authenticated)
    return (
      <Login
        session={session}
        initialUsername={loginUsername}
        onLogin={(value) => {
          auth.acceptLogin(value);
          clearNotice();
        }}
      />
    );

  return (
    <HubLayout
      session={session}
      snapshot={snapshot}
      view={view}
      selected={selected}
      brokerConnected={brokerConnected}
      navigate={navigate}
      logout={logout}
    >
      <PageHeading
        snapshot={snapshot}
        selected={selected}
        navigation={navigation}
        refreshing={refreshing}
        refresh={refresh}
      />
      <ConnectionNotice snapshot={snapshot} loadError={loadError} />
      <ActionNotice notice={notices.notice} onDismiss={clearNotice} />
      {snapshot &&
      !configuringId &&
      ((view === 'overview' && !selected) || Boolean(selected?.controllers.security)) ? (
        <HouseSecurityStatus view={snapshot.houseSecurity} unavailable={!brokerConnected} />
      ) : null}
      {snapshot && ((view === 'overview' && !selected && !configuringId) || view === 'scenes') ? (
        <ScenesPanel
          snapshot={snapshot.scenes}
          devices={devices}
          unavailable={Boolean(loadError)}
          manualBusy={commands.pending.size > 0}
          onRunAccepted={scenes.acceptSceneRun}
          onSaved={scenes.acceptSceneDefinition}
          onStarting={(starting) => {
            commands.setSceneStarting(starting);
            if (starting) clearNotice();
          }}
          onDeleted={scenes.deleteSceneDefinition}
          clearNoticeToken={notices.clearSceneNoticeToken}
          expanded={view === 'scenes'}
          showQuick={view === 'overview' && !selected && !configuringId}
        />
      ) : null}
      {view === 'telegram' ? (
        <TelegramPanel snapshot={snapshot} />
      ) : view === 'cloud' ? (
        <CloudPanel />
      ) : view === 'account' && !portal ? (
        <AccountPanel
          onChanged={(username) => {
            auth.setLoginUsername(username);
            void logout(false);
          }}
        />
      ) : !snapshot ? (
        <div class="loading-panel panel">
          <Icon name="refresh" />
          <p>Ожидаем данные хаба…</p>
        </div>
      ) : view === 'pult' ? (
        <PultPage
          snapshot={snapshot}
          pending={commands.pending}
          connected={brokerConnected}
          controlsBlocked={
            !canControl || commands.sceneStarting || Boolean(snapshot.scenes.activeRun)
          }
          onCommand={commands.command}
          openDevice={navigation.openDevice}
        />
      ) : configuringId || selected ? (
        <DevicePage
          snapshot={snapshot}
          selected={selected}
          navigation={navigation}
          commands={commands}
          brokerConnected={brokerConnected}
          clearNotice={clearNotice}
        />
      ) : view === 'activity' ? (
        <ActivityPage snapshot={snapshot} />
      ) : view === 'scenes' ? null : (
        <DevicesPage snapshot={snapshot} navigation={navigation} />
      )}
    </HubLayout>
  );
}
