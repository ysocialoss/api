import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "./db/index.ts";
import { posts, users } from "./db/schema.ts";
import { postSelection, serializePost } from "./post-data.ts";

export async function loadAncestors(
  page: { id: string; parentId: string | null }[],
  viewerId: string | null,
) {
  const replyIds = page.filter((row) => row.parentId).map((row) => row.id);
  const result = new Map<string, ReturnType<typeof serializePost>[]>();
  if (!replyIds.length) return result;
  const chains = await db.execute<{ origin: string; id: string }>(sql`
    with recursive chain as (
      select id as origin, parent_id as id, 1 as depth
      from posts where id in (${sql.join(
        replyIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}) and parent_id is not null
      union all
      select c.origin, p.parent_id, c.depth + 1
      from chain c join posts p on p.id = c.id
      where p.parent_id is not null and c.depth < 100
    )
    select origin, id from chain order by origin, depth desc
  `);
  const ancestorRows = await db
    .select(postSelection(viewerId))
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(and(isNull(users.bannedAt), isNull(posts.hiddenAt), inArray(posts.id, [...new Set(chains.rows.map((row) => row.id))])));
  const byId = new Map(ancestorRows.map((row) => [row.id, serializePost(row)]));
  for (const { origin, id } of chains.rows) {
    const found = byId.get(id);
    if (found) result.set(origin, [...(result.get(origin) ?? []), found]);
  }
  return result;
}
