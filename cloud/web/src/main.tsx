/** @file Точка входа облачной панели FCPLCn: стили и монтаж приложения. */
import { render } from 'preact';
import { App } from './app/app';
import './style.css';

render(<App />, document.getElementById('app')!);
