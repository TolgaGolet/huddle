import { Component, type ReactNode } from "react";
import { errorName, huddleWarn } from "../lib/huddleLog";

interface Props {
  children: ReactNode;
  fallback: (reset: () => void) => ReactNode;
}

interface State {
  failed: boolean;
}

/** Shows `fallback` instead of unmounting the whole app when a child throws while rendering. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    huddleWarn("ui", { event: "render-crash", error: errorName(error) });
  }

  private reset = () => this.setState({ failed: false });

  render() {
    return this.state.failed ? this.props.fallback(this.reset) : this.props.children;
  }
}

const BUTTON = "px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors cursor-pointer";

export function AppCrashed() {
  return (
    <div role="alert" className="min-h-screen flex flex-col items-center justify-center gap-4 bg-gray-950 px-4 text-center">
      <p className="text-gray-200">Something went wrong and Huddle had to stop.</p>
      <button onClick={() => window.location.reload()} className={BUTTON}>
        Reload
      </button>
    </div>
  );
}

/** Keeps the call running: only the chat column is replaced. */
export function ChatCrashed(reset: () => void) {
  return (
    <div role="alert" className="h-full flex flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-gray-200">The chat hit a problem. Your call is still connected.</p>
      <button onClick={reset} className={BUTTON}>
        Reload chat
      </button>
    </div>
  );
}
