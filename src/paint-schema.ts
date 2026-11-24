import { z } from "zod";

const paintStopSchema = z.strictObject({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  at: z.number().min(0).max(1),
});

const paintStopsSchema = z.array(paintStopSchema).min(2).max(8).refine(
  (stops) => stops.every((stop, index) => index === 0 || stop.at >= stops[index - 1]!.at),
  { message: "stops must be in ascending order" },
);

export const paintDefinitionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("linear"),
    angle: z.number().min(0).max(360),
    stops: paintStopsSchema,
  }),
  z.strictObject({
    kind: z.literal("radial"),
    shape: z.enum(["circle", "ellipse"]),
    stops: paintStopsSchema,
  }),
]);

export type PaintStop = z.output<typeof paintStopSchema>;
export type PaintDefinition = z.output<typeof paintDefinitionSchema>;
