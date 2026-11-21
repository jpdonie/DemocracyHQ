// First, before any module that defines a data schema (see zodSetup.ts).
import './lib/zodSetup';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/newsreader/wght.css';
import '@fontsource-variable/newsreader/wght-italic.css';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './App';
import { moveLink, trackMoveStarts } from './lib/router';
import { trackPlaces } from './lib/scrollMemory';

const root = document.getElementById('root');
if (root) {
  // Records where each move to another view starts, so focus can follow the move without taking it back from the reader.
  trackMoveStarts();
  // Keeps the reader's place in each view per history entry, so Back and Forward return to it. Started before the app,
  // so that on each change of address the place is read before the app draws the next view.
  trackPlaces(() => document.getElementById('panel'), moveLink);
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
