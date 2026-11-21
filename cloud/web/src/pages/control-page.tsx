/** @file Общая панель хаба; стабильный iframe сохраняет собственную навигацию и черновики PLC. */
import type { RefObject } from 'preact';
import type { HomeView, HubView } from '../../../shared/api.js';
import { Icon } from '../icons';

interface ControlPageProps {
  home: HomeView;
  activeHub: HubView | undefined;
  frame: RefObject<HTMLIFrameElement | null>;
  height: number;
  onConnect: () => void;
}

export function ControlPage({ home, activeHub, frame, height, onConnect }: ControlPageProps) {
  return activeHub ? (
    <div class="portal-host">
      <iframe
        ref={frame}
        key={`${home.id}:${home.role}:${home.securityControl}`}
        title={'Управление домом ' + home.name}
        data-hub-portal
        src={'/portal/' + encodeURIComponent(home.id)}
        style={{ height: height + 'px' }}
      />
    </div>
  ) : (
    <section class="panel empty-state compact">
      <Icon name="hub" />
      <h2>Добавьте хаб вашего дома</h2>
      <p>После однократной привязки здесь появится привычная панель PLC, сценариев и настроек.</p>
      <button class="button" onClick={onConnect}>
        Подключить хаб
        <Icon name="arrow" />
      </button>
    </section>
  );
}
