import { sql } from "drizzle-orm";
import { postLikes, posts, users } from "./db/schema.ts";

export const postFields = {
  id: posts.id,
  content: posts.content,
  createdAt: posts.createdAt,
  editedAt: posts.editedAt,
};
export function reactionSelection(viewerId: string | null) {
  return {
    likes: sql<number>`(select count(*)::int from ${postLikes} where ${postLikes.postId} = ${posts.id})`,
    liked:
      viewerId === null
        ? sql<boolean>`false`
        : sql<boolean>`exists(select 1 from ${postLikes} where ${postLikes.postId} = ${posts.id} and ${postLikes.userId} = ${viewerId})`,
  };
}
export const postSelection = (viewerId: string | null) => ({
  ...reactionSelection(viewerId),
  ...postFields,
  author: {
    id: users.id,
    handle: users.handle,
    displayName: users.displayName,
  },
});
type PostRow = { createdAt: Date };
export function serializePost<T extends PostRow>(post: T) {
  return {
    ...post,
    editExpiresAt: new Date(
      post.createdAt.getTime() + 15 * 60000,
    ).toISOString(),
  };
}
