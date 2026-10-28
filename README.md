what do we need?

- auth
  - we looove cns accounts
- user profiles
  - customization (colour, banner gif + img, avatar gif + img)
- communities
  - seperated from main feed
  - tags (similar to discord)
- posts
    - types (voice, live irc type shi, images, video, *streams*)
- *chats
  - dm & group messages ENCRYPTION

api brainstorm
base: ysocial.cc/api/

POST /post
```json 
{
  "content": "message",
  "type": "text" || "image" || "video" || "voice" || "live" || "streams"
}
```
example of a live post:
```json 
{
  "content": "This is a post!",
  "type": "live"
}
```
