/** @file Точка входа веб-интерфейса FCPLCn: приложение и общие стили. */
import { render } from 'preact';
import { App } from './app/app';
import './style.css';

render(<App />, document.getElementById('app')!);
