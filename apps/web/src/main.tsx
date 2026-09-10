import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import '@devtodo/ui/tokens.css';
import './styles.css';
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
