import { sql } from "drizzle-orm";
import { postLikes, postReposts, posts, users } from "./db/schema.ts";

export const postFields = {
  id: posts.id,
  parentId: posts.parentId,
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
export function repostSelection(viewerId: string | null) {
  return {
    reposts: sql<number>`(select count(*)::int from ${postReposts} where ${postReposts.postId} = ${posts.id})`,
    reposted:
      viewerId === null
        ? sql<boolean>`false`
        : sql<boolean>`exists(select 1 from ${postReposts} where ${postReposts.postId} = ${posts.id} and ${postReposts.userId} = ${viewerId})`,
  };
}
export const postSelection = (viewerId: string | null) => ({
  ...reactionSelection(viewerId),
  ...repostSelection(viewerId),
  ...postFields,
  replies: sql<number>`(select count(*)::int from posts reply where reply.parent_id = ${posts.id})`,
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
