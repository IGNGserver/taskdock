import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

/* Token layer first, then components, then page styles, then the adaptive
   overrides — the import order is the cascade layering contract. */
import '@devtodo/ui/tokens.css';
import './styles/type.css';
import './components/m3e/button.css';
import './components/m3e/field.css';
import './components/m3e/container.css';
import './components/m3e/navigation.css';
import './styles/base.css';
import './styles/tasks.css';
import './styles/pages.css';
import './styles/motion.css';
import './styles/responsive.css';
import { App } from './App.js';
import { AuthProvider } from './auth.js';
import { installTheme } from './theme.js';

installTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
