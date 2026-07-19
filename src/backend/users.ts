import { BackendClient } from "./client";
import { BackendUser } from "./types";

/** Body for PATCH /api/v3/users/me — mirrors backend `UserUpdate`
 *  (backend/src/models/users.rs, camelCase serde). `socialLinks` are the
 *  free-form (unverified) label/url pairs; passing the field REPLACES the
 *  whole set (server-validated: count/label-length/https + domain whitelist).
 *  These are distinct from the OAuth-verified provider links (/users/me/socials). */
export interface ProfileUpdate {
  displayName?: string;
  username?: string;
  bio?: string;
  lang?: string;
  telemetryOptIn?: boolean;
  socialLinks?: { label: string; url: string }[];
}

export function buildUsersApi(client: BackendClient) {
  const path = (ref: string) => `/users/${encodeURIComponent(ref)}`;

  return {
    me: () => client.get<BackendUser>("/users/me"),

    get: (ref: string) => client.get<BackendUser>(path(ref)),

    updateMe: (body: ProfileUpdate) => client.patch<BackendUser>("/users/me", body),

    avatar: () => client.getRoot<string>("/me/avatar"),

    /** V3 avatar upload — multipart/form-data (`file` field) to
     *  POST /api/v3/users/me/avatar. BackendClient now handles a FormData body
     *  (skips JSON serialization + Content-Type). Backend validates format
     *  (png/jpeg/webp/gif) + size and stores a self-contained data URI. */
    uploadAvatar: (file: File | Blob) => {
      const fd = new FormData();
      fd.append("file", file);
      return client.post<{ ok?: boolean; url?: string }>("/users/me/avatar", fd);
    },

    /** @deprecated legacy V1 base64 upload; use {@link uploadAvatar}. */
    setAvatar: (image: string) => client.putRoot("/me/avatar", { image }),

    /** Remove the custom avatar (falls back to Discord → identicon chain).
     *  V3: DELETE /api/v3/users/me/avatar. */
    deleteAvatar: () => client.delete("/users/me/avatar"),

    deleteMe: (reason?: string) =>
      client.postRoot("/me/delete", { confirm: true, reason }),
  };
}
