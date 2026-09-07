import type { ClubhouseFeedPost } from './feedgen'

/** Profile lookups must not replace posts that changed while the lookup ran. */
export function mergeFeedAuthors(
  posts: readonly ClubhouseFeedPost[],
  enrichedPosts: readonly ClubhouseFeedPost[],
): ClubhouseFeedPost[] {
  const authors = new Map(enrichedPosts.map((post) => [post.uri, post.author]))
  return posts.map((post) => {
    const author = authors.get(post.uri)
    if (!author || author.did !== post.author.did) return post
    return {
      ...post,
      author: {
        ...post.author,
        handle: author.handle ?? post.author.handle,
        displayName: author.displayName ?? post.author.displayName,
        avatar: author.avatar ?? post.author.avatar,
      },
    }
  })
}
