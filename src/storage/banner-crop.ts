import { z } from "zod";
export const bannerCropSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine(
    (crop) => crop.x + crop.width <= 1.00001 && crop.y + crop.height <= 1.00001,
    "Crop must fit the image",
  );
export type BannerCrop = z.infer<typeof bannerCropSchema>;
