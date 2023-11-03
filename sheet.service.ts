import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { SheetRepository } from './sheet.repository';
import { Cell, Sheet } from './sheet.schema';
import {
  calculateExpression,
  getExpressionVariables,
  isExpression,
} from '../utils';

export type CellReturnType = { value: string; result: string };

@Injectable()
export class SheetService {
  constructor(private sheetRepo: SheetRepository) {}

  async upsert({
    sheetId,
    cellId,
    value: rawValue,
  }: {
    sheetId: string;
    cellId: string;
    value: string;
  }): Promise<CellReturnType | null> {
    const value = `${rawValue}`;
    let sheet = await this.sheetRepo.findSheet({ sheetId });

    if (!sheet) {
      sheet = { name: sheetId, cells: new Map() };
    }

    const currentCell: Cell = { value, result: value };
    const oldValue = sheet.cells.get(cellId);

    if (currentCell.value === oldValue?.value) {
      const updatedSheet = await this.sheetRepo.update({ sheetId });

      return this.mapToCell(updatedSheet, cellId);
    }

    if (oldValue?.usedIn) {
      currentCell.usedIn = oldValue.usedIn;
    }

    if (isExpression(value.trim())) {
      const expression = value.trim().substring(1);
      currentCell.vars = getExpressionVariables(expression);

      this.validateVarsByUsedIn(currentCell);

      // to detect circular dependency
      delete currentCell.vars[cellId];

      const scoupe = this.getScoupeBySheet(
        sheet,
        Object.keys(currentCell.vars),
        value,
      );

      try {
        currentCell.result = calculateExpression(expression, scoupe);
      } catch (e) {
        throw new UnprocessableEntityException({ value, result: 'ERROR' });
      }

      sheet = this.updateUsedIn(
        sheet,
        Object.keys(currentCell.vars),
        cellId,
        value,
      );
    }

    sheet = this.removeOldReferences(
      sheet,
      Object.keys(oldValue?.vars || {}),
      currentCell,
      cellId,
    );

    sheet.cells.set(cellId, currentCell);
    sheet = this.updateDependentCells(sheet, currentCell);

    const updatedSheet = await this.sheetRepo.upsert({
      sheetId,
      cells: sheet.cells,
    });

    return this.mapToCell(updatedSheet!, cellId);
  }

  async findByCell({
    sheetId,
    cellId,
  }: {
    sheetId: string;
    cellId: string;
  }): Promise<CellReturnType | null> {
    const sheet = await this.sheetRepo.findByCell({ sheetId, cellId });

    if (!sheet) {
      return null;
    }

    return this.mapToCell(sheet, cellId);
  }

  async findSheet({
    sheetId,
  }: {
    sheetId: string;
  }): Promise<{ [key: string]: CellReturnType } | null> {
    const sheet = await this.sheetRepo.findSheet({ sheetId });

    if (!sheet) {
      return null;
    }

    const response: { [key: string]: CellReturnType } = {};
    const keys = sheet?.cells.keys();

    for (const key of keys) {
      response[key] = this.mapToCell(sheet, key);
    }

    return response;
  }

  async findAll(): Promise<Sheet[]> {
    return this.sheetRepo.findAll();
  }

  private mapToCell(sheet: Sheet, cellName: string): CellReturnType {
    const { value, result } = sheet.cells.get(cellName)!;

    return {
      value,
      result,
    };
  }

  private getScoupeBySheet(
    sheet: Sheet,
    vars: string[],
    value: string,
  ): { [key: string]: string } {
    const scoupe: { [key: string]: string } = {};

    for (const item of vars) {
      const itemCell = sheet.cells.get(item);
      if (!itemCell) {
        throw new UnprocessableEntityException({ value, result: 'ERROR' });
      }

      scoupe[item] = itemCell.result;
    }

    return scoupe;
  }

  private updateUsedIn(
    sheet: Sheet,
    vars: string[],
    cellId: string,
    value: string,
  ): Sheet {
    for (const item of vars) {
      const itemCell = sheet.cells.get(item);
      if (!itemCell) {
        throw new UnprocessableEntityException({ value, result: 'ERROR' });
      }

      if (itemCell.usedIn) {
        itemCell.usedIn[cellId] = true;
      } else {
        itemCell.usedIn = { [cellId]: true };
      }

      sheet.cells.set(item, itemCell);
    }

    return sheet;
  }

  private removeOldReferences(
    sheet: Sheet,
    oldVars: string[],
    currentCell: Cell,
    cellId: string,
  ): Sheet {
    for (const cellName of oldVars) {
      if (!currentCell.vars?.[cellName]) {
        const itemCell = sheet.cells.get(cellName)!;

        delete itemCell.usedIn?.[cellId];

        sheet.cells.set(cellName, itemCell);
      }
    }

    return sheet;
  }

  private updateDependentCells(sheet: Sheet, currentCell: Cell): Sheet {
    // recalculate all cells which result depends on the current cell
    for (const cellName of Object.keys(currentCell.usedIn || {})) {
      const itemCell = sheet.cells.get(cellName);

      if (!itemCell) {
        throw new UnprocessableEntityException({
          value: currentCell.value,
          result: 'ERROR',
        });
      }

      const expression = itemCell.value.trim().substring(1);
      const scoupe = this.getScoupeBySheet(
        sheet,
        Object.keys(itemCell?.vars || {}),
        currentCell.value,
      );

      itemCell.result = calculateExpression(expression, scoupe);
      sheet.cells.set(cellName, itemCell);

      // recalculate all cells which result depends on the item cell
      sheet = this.updateDependentCells(sheet, itemCell);
    }

    return sheet;
  }

  private validateVarsByUsedIn(cell: Cell): boolean {
    if (!cell.usedIn) {
      return true;
    }

    for (const cellName of Object.keys(cell.vars || {})) {
      if (cell.usedIn?.[cellName]) {
        throw new UnprocessableEntityException({
          value: cell.value,
          result: 'ERROR',
        });
      }
    }

    return true;
  }
}
