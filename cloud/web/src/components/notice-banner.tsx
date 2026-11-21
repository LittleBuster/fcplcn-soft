/** @file Одно закрываемое сообщение результата текущего действия. */
import type { Notice } from '../app/types';
import { Icon } from '../icons';

export function NoticeBanner({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  return (
    <div class={'notice ' + notice.kind} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <Icon name={notice.kind === 'error' ? 'shield' : 'check'} />
      <span>{notice.text}</span>
      <button class="icon-button" aria-label="Закрыть уведомление" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
