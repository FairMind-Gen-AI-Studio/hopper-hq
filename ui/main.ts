import { mount } from 'svelte';
import App from './App.svelte';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';

const target = document.getElementById('app');
if (target) mount(App, { target });

// Only in a production build, and only best-effort: the dev server has no sw.js, and a browser without
// service worker support (or one that refuses for some other reason) still gets the page.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/ui/sw.js', { scope: '/ui/' }).catch(() => {});
}
