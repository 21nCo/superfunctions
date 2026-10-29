/** pg's internal parameter serializer, used to prove textArrayParam sends the same wire value. */
declare module "pg/lib/utils.js" {
  const utils: { prepareValue(value: unknown): unknown };
  export default utils;
}
