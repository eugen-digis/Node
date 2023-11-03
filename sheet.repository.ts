import { Model } from 'mongoose';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cell, Sheet } from './sheet.schema';

@Injectable()
export class SheetRepository {
  constructor(@InjectModel(Sheet.name) private sheetModel: Model<Sheet>) {}

  async upsert({
    sheetId,
    cells,
  }: {
    sheetId: string;
    cells: Map<string, Cell>;
  }): Promise<Sheet> {
    const sheet = await this.sheetModel.findOneAndUpdate(
      {
        name: sheetId,
      },
      {
        name: sheetId,
        cells,
      },
      {
        new: true,
        upsert: cells ? true : false,
      },
    );

    return this.mapToSheet(sheet) as Sheet;
  }

  async update({ sheetId }: { sheetId: string }): Promise<Sheet> {
    const sheet = await this.sheetModel.findOneAndUpdate(
      {
        name: sheetId,
      },
      {
        name: sheetId,
      },
      {
        new: true,
      },
    );

    return this.mapToSheet(sheet) as Sheet;
  }

  async findByCell({
    sheetId,
    cellId,
  }: {
    sheetId: string;
    cellId: string;
  }): Promise<Sheet | null> {
    const query = {
      name: sheetId,
      [`cells.${cellId}`]: { $exists: true },
    };

    const sheet = await this.sheetModel.findOne(query).exec();

    return this.mapToSheet(sheet);
  }

  async findSheet({ sheetId }: { sheetId: string }): Promise<Sheet | null> {
    const sheet = await this.sheetModel.findOne({ name: sheetId }).exec();
    return this.mapToSheet(sheet);
  }

  async findAll(): Promise<Sheet[]> {
    return this.sheetModel.find().exec();
  }

  private mapToSheet(sheet: Sheet | null): Sheet | null {
    if (!sheet) {
      return null;
    }

    sheet.cells = new Map(Object.entries(sheet.cells ? sheet.cells : {}));
    return sheet;
  }
}
