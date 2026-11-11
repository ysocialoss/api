import { sql } from "drizzle-orm";
import { authIdentities, users } from "./db/schema.ts";

export const userSelection = {
  id: users.id,
  handle: users.handle,
  displayName: users.displayName,
  // Preserve the outer table reference in Drizzle's single-table selections.
  avatarUrl: sql<
    string | null
  >`coalesce('/api/' || ${users.avatarKey}, (select ${authIdentities.picture} from ${authIdentities} where ${authIdentities.userId} = ${users}.${sql.identifier(users.id.name)} and ${authIdentities.deletedAt} is null))`,
};
