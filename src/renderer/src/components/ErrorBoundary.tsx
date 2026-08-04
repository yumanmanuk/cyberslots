/**
 * ErrorBoundary — last line of defense: a component crash degrades to an
 * inline error card instead of unmounting the whole app (white screen).
 */

import { Component, type ReactNode } from 'react';

import { translate } from '../i18n';
import { rlog } from '../log/logger';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    rlog.error('ui.error', 'component crash boundary hit', { componentStack: info.componentStack ?? undefined }, error);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-8">
          <div className="text-sm font-medium text-err">{translate('errUiCrash')}</div>
          <pre className="max-h-48 max-w-2xl overflow-auto rounded-lg bg-bg-panel px-4 py-3 font-mono text-[12px] text-ink-soft">
            {this.state.error.message}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            className="rounded-lg border border-line bg-bg-input px-4 py-1.5 text-ui hover:bg-bg-hover hover:text-ink"
          >
            {translate('errUiRetry')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
