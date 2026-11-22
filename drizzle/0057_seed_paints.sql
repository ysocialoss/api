INSERT INTO "paints" ("name", "definition", "is_free", "sort_order") VALUES
  ('Sonnenuntergang', '{"kind":"linear","angle":90,"stops":[{"color":"#d04e0b","at":0},{"color":"#dd317d","at":1}]}', true, 10),
  ('Wasser', '{"kind":"linear","angle":90,"stops":[{"color":"#027fc0","at":0},{"color":"#0c877c","at":1}]}', true, 20),
  ('Wald', '{"kind":"linear","angle":90,"stops":[{"color":"#178b42","at":0},{"color":"#53860b","at":1}]}', true, 30),
  ('Aurora', '{"kind":"linear","angle":120,"stops":[{"color":"#0783a1","at":0},{"color":"#8f57f0","at":0.5},{"color":"#dd317d","at":1}]}', true, 100),
  ('Galaxy', '{"kind":"linear","angle":135,"stops":[{"color":"#6f67ea","at":0},{"color":"#a14ded","at":0.5},{"color":"#c62ed9","at":1}]}', true, 120),
  ('Gold', '{"kind":"linear","angle":90,"stops":[{"color":"#c35a0a","at":0},{"color":"#a26f03","at":0.5},{"color":"#c35a0a","at":1}]}', false, 130)
ON CONFLICT ("name") DO NOTHING;

-- Die Farben sind btw Ai generated, weil man für coole patterns actually kreativ sein müsste und da bin ich raus