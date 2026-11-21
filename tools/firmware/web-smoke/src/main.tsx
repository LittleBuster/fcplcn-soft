import { render } from 'preact';
import { App } from './app';
import './style.css';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Web smoke test root element is missing');
}
render(<App />, root);
