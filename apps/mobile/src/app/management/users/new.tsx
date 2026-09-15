import { Redirect } from "expo-router";
export default function LegacyUserCreation() {
  return <Redirect href={{ pathname: "/(app)/(tabs)/users", params: { create: "true" } }} />;
}
