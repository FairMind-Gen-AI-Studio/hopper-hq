import { mount } from 'svelte';
import App from './App.svelte';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';

const target = document.getElementById('app');
if (target) mount(App, { target });
