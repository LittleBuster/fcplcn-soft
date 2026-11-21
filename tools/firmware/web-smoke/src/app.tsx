import { useState } from 'preact/hooks';
import product from '../../../../config/product.json';

// This page verifies the web build tools; it is not the device interface.
export function App() {
  const [checked, setChecked] = useState(false);

  return (
    <main>
      <h1>{product.name}</h1>
      <p>{product.fullName}</p>
      <p>TypeScript, Preact and the production build are ready for verification.</p>
      <button type="button" onClick={() => setChecked(true)}>
        Run browser check
      </button>
      <p role="status">{checked ? 'Browser check passed' : 'Ready to check'}</p>
    </main>
  );
}
