/** @file Форма создания отдельного дома; черновик хранится в оболочке между открытиями. */
import type { HomeView } from '../../../shared/api.js';
import type { CloudAction } from '../app/types';

interface CreateHomeFormProps {
  newHome: string;
  setNewHome: (name: string) => void;
  setCreating: (creating: boolean) => void;
  busy: boolean;
  act: CloudAction;
  onCreated: (id: string) => void;
}

export function CreateHomeForm({
  newHome,
  setNewHome,
  setCreating,
  busy,
  act,
  onCreated,
}: CreateHomeFormProps) {
  return (
    <form
      class="panel create-home"
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          const next = await act<HomeView>(
            '/homes',
            { name: newHome.trim() },
            'POST',
            'Дом создан. Можно привязать локальный хаб.',
          );
          if (next) {
            onCreated(next.id);
            setCreating(false);
            setNewHome('');
          }
        } catch {}
      }}
    >
      <div>
        <h2>Новый дом</h2>
        <p>Отдельный объект со своим хабом, устройствами и доступом.</p>
      </div>
      <label>
        Название
        <input
          value={newHome}
          onInput={(event) => setNewHome(event.currentTarget.value)}
          maxLength={96}
          required
          placeholder="Дом, дача, квартира"
        />
      </label>
      <button class="button" disabled={busy || !newHome.trim()}>
        Создать дом
      </button>
      <button class="text-button" type="button" onClick={() => setCreating(false)}>
        Отмена
      </button>
    </form>
  );
}
