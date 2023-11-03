import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CellReturnType, SheetService } from './sheet.service';
import { transformUrl } from '../utils';

@Controller('/api/v1/')
export class SheetController {
  constructor(private readonly sheetService: SheetService) {}

  @Post(':sheet_id/:cell_id')
  async upsert(
    @Body() data: { value: string },
    @Param('sheet_id') sheetId: string,
    @Param('cell_id') cellId: string,
  ): Promise<CellReturnType> {
    try {
      const result = await this.sheetService.upsert({
        sheetId: transformUrl(sheetId),
        cellId: transformUrl(cellId),
        value: data.value,
      });

      if (!result) {
        throw new NotFoundException();
      }

      return result;
    } catch(e) {
      throw new UnprocessableEntityException({ value: cellId, result: 'ERROR' });
    }
  }

  @Get(':sheet_id/:cell_id')
  async getCell(
    @Param('sheet_id') sheetId: string,
    @Param('cell_id') cellId: string,
  ): Promise<CellReturnType> {
    const result = await this.sheetService.findByCell({
      sheetId: transformUrl(sheetId),
      cellId: transformUrl(cellId),
    });

    if (!result) {
      throw new NotFoundException();
    }

    return result;
  }

  @Get(':sheet_id')
  async getSheet(
    @Param('sheet_id') sheetId: string,
  ): Promise<{ [key: string]: CellReturnType }> {
    const result = await this.sheetService.findSheet({
      sheetId: transformUrl(sheetId),
    });

    if (!result) {
      throw new NotFoundException();
    }

    return result;
  }
}
