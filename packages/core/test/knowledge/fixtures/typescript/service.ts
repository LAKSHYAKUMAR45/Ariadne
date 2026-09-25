import type { Disposable } from './contracts';
import { createLogger, type Logger } from './logger';

export interface ServiceConfig {
  name: string;
  enabled: boolean;
}

class BaseService {
  protected started = false;
}

export class DeviceService extends BaseService implements Disposable {
  constructor(
    private readonly logger: Logger,
    private readonly config: ServiceConfig,
  ) {
    super();
  }

  start(): void {
    this.started = this.config.enabled;
    this.logger.info(this.config.name);
    createLogger(this.config.name);
  }

  dispose(): void {
    this.started = false;
  }
}

export function buildService(config: ServiceConfig): DeviceService {
  const logger = createLogger(config.name);
  return new DeviceService(logger, config);
}
