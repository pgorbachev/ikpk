export default {
  routes: [
    {
      method: 'PUT',
      path: '/media-import-identities/:id',
      handler: 'media-import-identity.set',
      config: {
        auth: { scope: ['api::media-import-identity.media-import-identity.set'] },
      },
    },
  ],
};
