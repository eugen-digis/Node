import { LOGGER_PROVIDER } from '@logger';
import { Prisma, Validation } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

const PROCESSING_STARTED_AT_OFFSET = 1000 * 60 * 5;

@Injectable()
export class ValidationRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(LOGGER_PROVIDER) private readonly logger: LoggerService,
  ) {}

  async create(
    // TODO: create a better type for this
    data: Prisma.ValidationCreateArgs['data'],
    transactionClient?: Prisma.TransactionClient,
  ): Promise<Validation> {
    return (transactionClient || this.prisma).validation.create({
      data,
    });
  }

  async updateById(
    id: number,
    // TODO: create a better type for this
    data: Prisma.ValidationUpdateArgs['data'],
    transactionClient?: Prisma.TransactionClient,
  ) {
    return (transactionClient || this.prisma).validation.update({
      data,
      where: {
        id,
      },
    });
  }

  async getNotProcessed(): Promise<Validation[]> {
    return this.prisma.validation.findMany({
      where: {
        processed: false,
        OR: [
          {
            processing_started_at: {
              lte: new Date(Date.now() - PROCESSING_STARTED_AT_OFFSET),
            },
          },
          {
            processing_started_at: null,
          },
        ],
      },
    });
  }

  async setProcessingStartedAt(ids: number[]): Promise<void> {
    await this.prisma.validation.updateMany({
      where: {
        id: {
          in: ids,
        },
      },
      data: {
        processing_started_at: new Date(),
      },
    });
  }

  async setProcessed(ids: number[]): Promise<void> {
    await this.prisma.validation.updateMany({
      where: {
        id: {
          in: ids,
        },
      },
      data: {
        processed: true,
      },
    });
  }
}
