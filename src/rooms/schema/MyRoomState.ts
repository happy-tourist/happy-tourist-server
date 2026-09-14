import { schema, t, type SchemaType } from "@colyseus/schema";

export const Seat = schema(
  {
    touristId: t.uint8(),
    side: t.string(),
    row: t.uint8(),
    col: t.uint8(),
  },
  "Seat",
);
export type Seat = SchemaType<typeof Seat>;

export const MyRoomState = schema(
  {
    started: t.boolean().default(false),
    seats: t.map(Seat),
  },
  "MyRoomState",
);
export type MyRoomState = SchemaType<typeof MyRoomState>;
