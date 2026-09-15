import { Redirect, useLocalSearchParams } from "expo-router";
export default function EditManagedUserScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={{ pathname: "/(app)/(tabs)/users", params: { userId: id } }} />;
}
