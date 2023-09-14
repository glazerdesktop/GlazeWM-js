import {
  ClientMessage,
  GwmEventType,
  GwmEventData,
  Monitor,
  ServerMessage,
  Workspace,
  GwmCommand,
  Container,
  EventSubscription,
} from './types';

export interface GwmClientOptions {
  /** IPC server port to connect to. Defaults to `6123`.  */
  port?: number;
}

/** Unregister a callback. */
export type UnlistenFn = () => void;

export type MessageCallback = (e: MessageEvent<string>) => void;
export type ConnectCallback = (e: Event) => void;
export type DisconnectCallback = (e: CloseEvent) => void;
export type ErrorCallback = (e: Event) => void;
export type SubscribeCallback<T extends GwmEventType> = (
  data: GwmEventData<T>,
) => void;

export class GwmClient {
  private readonly DEFAULT_PORT = 6123;

  /** Websocket connection to IPC server. */
  private _socket: WebSocket | null = null;

  /** Promise used to prevent duplicate connections. */
  private _createSocketPromise: Promise<WebSocket> | null = null;

  private _onMessageCallbacks: MessageCallback[] = [];
  private _onConnectCallbacks: ConnectCallback[] = [];
  private _onDisconnectCallbacks: DisconnectCallback[] = [];
  private _onErrorCallbacks: ErrorCallback[] = [];

  /**
   * Instantiate client. Connection to IPC server is established when sending
   * the first message or by explicitly calling {@link connect}.
   */
  constructor(private _options?: GwmClientOptions) {}

  /**
   * Send an IPC message and wait for a reply.
   *
   * @throws If message is invalid or IPC server is unable to handle the message.
   */
  async sendAndWaitReply<T>(message: ClientMessage): Promise<T> {
    let unlisten: UnlistenFn;

    // Resolve when a reply comes in for the client message.
    return new Promise<T>(async (resolve, reject) => {
      await this.connect();
      this._socket!.send(message);

      unlisten = this.onMessage((e) => {
        const serverMessage: ServerMessage<T> = JSON.parse(e.data);

        // Whether the incoming message is a reply to the client message.
        const isReplyMessage =
          serverMessage.messageType === 'client_response' &&
          serverMessage.clientMessage === message;

        if (isReplyMessage && serverMessage.error) {
          reject(
            `Server reply to message '${message}' has error: ${serverMessage.error}`,
          );
        }

        if (isReplyMessage) {
          resolve(serverMessage.data as T);
        }
      });
    }).finally(() => unlisten());
  }

  /**
   * Get all monitors. {@link Monitor}
   */
  async getMonitors(): Promise<Monitor[]> {
    return this.sendAndWaitReply<Monitor[]>('monitors');
  }

  /**
   * Get all active workspaces. {@link Workspace}
   */
  async getWorkspaces(): Promise<Workspace[]> {
    return this.sendAndWaitReply<Workspace[]>('workspaces');
  }

  /**
   * Get all windows. {@link Window}
   */
  async getWindows(): Promise<Window[]> {
    return this.sendAndWaitReply<Window[]>('windows');
  }

  /**
   * Invoke a WM command (eg. "focus workspace 1").
   *
   * @param command WM command to run (eg. "focus workspace 1").
   * @param contextContainer (optional) Container or ID of container to use as
   * context. If not provided, this defaults to the currently focused container.
   * @throws If command fails.
   */
  async runCommand(
    command: GwmCommand,
    contextContainer?: Container | string,
  ): Promise<void> {
    if (!contextContainer) {
      await this.sendAndWaitReply<null>(`command "${command}"`);
      return;
    }

    const contextContainerId =
      typeof contextContainer === 'string'
        ? contextContainer
        : contextContainer!.id;

    await this.sendAndWaitReply<null>(
      `command "${command}" -c ${contextContainerId}`,
    );
  }

  /**
   * Establish websocket connection.
   *
   * @throws If connection attempt fails.
   */
  async connect(): Promise<void> {
    if (!this._socket) {
      const socketPromise =
        this._createSocketPromise ??
        (this._createSocketPromise = this._createSocket());

      this._socket = await socketPromise;
    }

    await this._waitForConnection();
  }

  /**
   * Close the websocket connection.
   */
  close(): void {
    this._socket?.close();
  }

  /**
   * Register a callback for one GlazeWM event.
   *
   * @example
   * ```typescript
   * const unlisten = await client.subscribe(
   *   GwmEventType.FOCUS_CHANGED,
   *   (event: FocusChangedEvent) => { ... }
   * });
   * ```
   */
  async subscribe<T extends GwmEventType>(
    event: T,
    callback: SubscribeCallback<T>,
  ): Promise<UnlistenFn> {
    return this.subscribeMany([event], callback);
  }

  /**
   * Register a callback for multiple GlazeWM events.
   *
   * @example
   * ```typescript
   * const unlisten = await client.subscribeMany(
   *   [GwmEventType.WORSPACE_ACTIVATED, GwmEventType.WORSPACE_DEACTIVATED],
   *   (event: WorkspaceActivatedEvent | WorkspaceDeactivatedEvent) => { ... }
   * );
   * ```
   */
  async subscribeMany<T extends GwmEventType[]>(
    events: T,
    callback: SubscribeCallback<T[number]>,
  ): Promise<UnlistenFn> {
    const response = await this.sendAndWaitReply<EventSubscription>(
      `subscribe -e ${events.join(',')}`,
    );

    const unlisten = this.onMessage((e) => {
      const serverMessage: ServerMessage<GwmEventData> = JSON.parse(e.data);

      const isSubscribedEvent =
        serverMessage.messageType === 'event_subscription' &&
        events.includes(serverMessage.data?.type!);

      if (isSubscribedEvent) {
        callback(serverMessage.data as GwmEventData<T[number]>);
      }
    });

    return async () => {
      unlisten();

      await this.sendAndWaitReply<EventSubscription>(
        `unsubscribe ${response.subscriptionId}`,
      );
    };
  }

  /**
   * Register a callback for when websocket messages are received.
   *
   * @example
   * ```typescript
   * const unlisten = client.onDisconnect(e => console.log(e));
   * ```
   */
  onMessage(callback: MessageCallback): UnlistenFn {
    return this._registerCallback(this._onMessageCallbacks, callback);
  }

  /**
   * Register a callback for when the websocket connects.
   *
   * @example
   * ```typescript
   * const unlisten = client.onDisconnect(e => console.log(e));
   * ```
   */
  onConnect(callback: ConnectCallback): UnlistenFn {
    return this._registerCallback(this._onConnectCallbacks, callback);
  }

  /**
   * Register a callback for when the websocket disconnects.
   *
   * @example
   * ```typescript
   * const unlisten = client.onDisconnect(e => console.log(e));
   * ```
   */
  onDisconnect(callback: DisconnectCallback): UnlistenFn {
    return this._registerCallback(this._onDisconnectCallbacks, callback);
  }

  /**
   * Register a callback for when the websocket connection has been closed due
   * to an error.
   *
   * @example
   * ```typescript
   * const unlisten = client.onError(e => console.error(e));
   * ```
   */
  onError(callback: ErrorCallback): UnlistenFn {
    return this._registerCallback(this._onErrorCallbacks, callback);
  }

  private _registerCallback<T>(callbacks: T[], newCallback: T): UnlistenFn {
    callbacks.push(newCallback);

    // Return a function to unregister the callback.
    return () => {
      for (const [index, callback] of callbacks.entries()) {
        if (callback === newCallback) {
          callbacks.splice(index, 1);
        }
      }
    };
  }

  private async _createSocket(): Promise<WebSocket> {
    // Get instance of `Websocket` to use. Uses the `Websocket` web API when
    // running in the browser, otherwise uses `ws` when running Node.
    const WebSocketApi = await (globalThis.WebSocket ??
      import('ws').catch(() => {
        throw new Error(
          "The dependency 'ws' is required for environments without a built-in" +
            ' WebSocket API. \nRun `npm i ws` to resolve this error.',
        );
      }));

    const socket = new WebSocketApi(
      `ws://localhost:${this._options?.port ?? this.DEFAULT_PORT}`,
    );

    socket.onmessage = (e) =>
      this._onMessageCallbacks.forEach((callback) => callback(e));

    socket.onopen = (e) =>
      this._onConnectCallbacks.forEach((callback) => callback(e));

    socket.onerror = (e) =>
      this._onErrorCallbacks.forEach((callback) => callback(e));

    socket.onclose = (e) =>
      this._onDisconnectCallbacks.forEach((callback) => callback(e));

    return socket;
  }

  async _waitForConnection(): Promise<WebSocket> {
    if (this._socket?.readyState === WebSocket.OPEN) {
      return this._socket;
    }

    let unlisten: UnlistenFn;

    return new Promise<WebSocket>(async (resolve) => {
      unlisten = this.onConnect(() => resolve(this._socket!));
    }).finally(() => unlisten());
  }
}
