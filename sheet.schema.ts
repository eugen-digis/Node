import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

export class Cell {
  value: string;
  result: string;
  vars?: { [key: string]: boolean };
  usedIn?: { [key: string]: boolean };
}

@Schema({ timestamps: true })
export class Sheet {
  @Prop({ unique: true, required: true })
  name: string;

  @Prop({ type: Types.Map, of: Cell })
  cells: Map<string, Cell>;
}

export const SheetSchema = SchemaFactory.createForClass(Sheet);
