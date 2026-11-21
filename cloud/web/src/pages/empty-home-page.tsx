/** @file Начальный экран учётной записи без доступных домов. */
import { Icon } from '../icons';

export function EmptyHomePage({ onCreateHome }: { onCreateHome: () => void }) {
  return (
    <section class="empty-state panel">
      <div class="empty-art">
        <Icon name="home" />
      </div>
      <span class="eyebrow">Начните со своего пространства</span>
      <h1>Ваш первый дом</h1>
      <p>
        Создайте дом, привяжите локальный хаб и пригласите тех, кому можно управлять устройствами.
      </p>
      <button class="button" onClick={onCreateHome}>
        <Icon name="plus" />
        Добавить дом
      </button>
    </section>
  );
}
