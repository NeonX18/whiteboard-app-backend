import mongoose, { Schema, Document } from "mongoose";

export interface IBoard extends Document {
  roomId: string;
  strokes: any[];
}

const BoardSchema: Schema = new Schema({
  roomId: { type: String, required: true, unique: true },
  strokes: { type: Array, default: [] },
});

export default mongoose.model<IBoard>("Board", BoardSchema);
