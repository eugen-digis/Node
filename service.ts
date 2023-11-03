import { compose, PassThrough } from 'stream';
import { LOGGER_PROVIDER } from '@logger';
import { Got, RequestError } from 'got';
import * as StreamArray from 'stream-json/streamers/StreamArray';
import { Inject, Injectable, LoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import GotBase from '@app/shared/http/GotBase';
import { AppService } from '../../app.service';
import { urlJoin } from '../../shared/helpers/urlJoin';
import { BatchCreateResult } from './types/BatchCreateResult';
import { BatchStatusResult } from './types/BatchStatusResult';
import { ContactResult } from './types/ContactResult';

const DEFAULT_REALTIME_VALIDATION_TIMEOUT_SECONDS = 10;

@Injectable()
export class Service {
  private client: Got;
  private callbackEndpoints = {
    batch: 'v1/integrations/bouncer/callback/batch',
  };

  constructor(
    @Inject(LOGGER_PROVIDER) private readonly logger: LoggerService,
    private readonly configService: ConfigService,
    private readonly appService: AppService,
  ) {
    const options = this.configService.get('integrations.service');
    this.client = GotBase.extend({
      prefixUrl: options.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': options.apiKey,
      },
    });
  }

  async validateBatch(
    data: Array<{ email: string; name?: string }>,
    secret?: string,
    callbackUrl?: string,
  ): Promise<CreateResult> {
    return this.client
      .post('v1/email/verify/batch', {
        json: data,
        searchParams: {
          callback:
            callbackUrl ||
            urlJoin(
              await this.appService.getApiUrl(),
              `${this.callbackEndpoints.batch}?secret=${secret}`,
            ),
        },
      })
      .json();
  }

  async getBatchResult(batchId: string): Promise<ContactResult[]> {
    return this.client.get(`v1/email/verify/batch/${batchId}`).json();
  }

  async getBatchStatus(batchId: string): Promise<BatchStatusResult> {
    return this.client.get(`v1.1/email/verify/batch/${batchId}`).json();
  }

  async validateInRealtime(email: string): Promise<ContactResult> {
    return this.client
      .get('v1.1/email/verify', {
        searchParams: {
          email,
          timeout: DEFAULT_REALTIME_VALIDATION_TIMEOUT_SECONDS,
        },
      })
      .json();
  }

  async getBatchResultAsStream(batchId: string) {
    const gotStream = await new Promise((resolve, reject) => {
      const stream = this.client.stream(
        `v1.1/email/verify/batch/${batchId}/download?download=all`,
      );
      stream.once('error', (err: RequestError | Error) => {
        this.logger.error('Error on get remote csv stream', {
          context: {
            err,
          },
        });
        reject(err);
      });
      stream.once('response', () => resolve(stream));
    });

    return compose(
      gotStream,
      StreamArray.withParser({}),
      new PassThrough({ objectMode: true }), // DO NOT REMOVE
    );
  }
}
