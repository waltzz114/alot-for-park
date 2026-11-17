import React, { useCallback, useEffect, useState } from "react";
import { SafeAreaView, View, Text, TouchableOpacity, StyleSheet, ScrollView, RefreshControl, Alert, Linking } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { StatusBar } from "expo-status-bar";

const API = process.env.EXPO_PUBLIC_API_URL || "http://10.0.2.2:3000";

export default function App() {
  const [slots, setSlots] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadSlots = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/slots`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not load slots");
      setSlots(d.slots || []);
    } catch (e) {
      Alert.alert("Connection problem", "Cannot reach the parking server. Check your API URL and connection.");
    }
  }, []);

  useEffect(() => {
    loadSlots();
    const timer = setInterval(loadSlots, 5000);
    return () => clearInterval(timer);
  }, [loadSlots]);

  async function reserve(slot) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not start booking");
      await WebBrowser.openBrowserAsync(d.checkoutUrl);
      await loadSlots();
      const check = await fetch(`${API}/api/bookings/${d.bookingId}`);
      const status = await check.json();
      if (status.booking?.status === "RESERVED") {
        Alert.alert("Booking confirmed", `Parking ${slot} is reserved. Reservation fee: ₹1.`);
      } else {
        Alert.alert("Payment not confirmed yet", "Return to the app and refresh your booking status. Your temporary slot hold may expire.");
      }
      await loadSlots();
    } catch (e) {
      Alert.alert("Booking error", e.message);
    } finally {
      setBusy(false);
    }
  }

  const available = slots.filter(s => s.status === "AVAILABLE").length;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.container} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async()=>{setRefreshing(true);await loadSlots();setRefreshing(false);}} tintColor="#54d9b9" />}>
        <View style={styles.header}>
          <View style={styles.logo}><Text style={styles.logoText}>A</Text></View>
          <View style={{flex:1}}><Text style={styles.brand}>'A'Lot For Park</Text><Text style={styles.subbrand}>SMART PARKING</Text></View>
          <View style={styles.live}><View style={styles.dot}/><Text style={styles.liveText}>LIVE</Text></View>
        </View>
        <Text style={styles.kicker}>PARK SMARTER</Text>
        <Text style={styles.title}>Your space.{"\n"}<Text style={styles.accent}>Without the search.</Text></Text>
        <Text style={styles.muted}>Find an available slot and reserve it before you arrive.</Text>
        <View style={styles.summary}>
          <Text style={styles.summaryLabel}>AVAILABLE PARKING SLOTS</Text>
          <Text style={styles.count}>{String(available).padStart(2,"0")}<Text style={styles.outOf}> / 04</Text></Text>
        </View>
        <View style={styles.sectionRow}><Text style={styles.sectionTitle}>Choose your slot</Text><Text style={styles.fee}>₹1 / booking</Text></View>
        {slots.map(s => {
          const color = s.status === "AVAILABLE" ? "#55ddb0" : s.status === "RESERVED" ? "#ffd07a" : "#ff8d94";
          return (
            <View key={s.slot} style={styles.slot}>
              <View><Text style={styles.slotName}>Parking {s.slot}</Text><Text style={styles.slotDesc}>{s.status === "AVAILABLE" ? "Ready to reserve" : s.status === "RESERVED" ? "Payment confirmed · Awaiting arrival" : "Vehicle detected"}</Text></View>
              <View style={{alignItems:"flex-end",gap:10}}>
                <Text style={[styles.tag,{color,borderColor:color}]}>{s.status}</Text>
                {s.status === "AVAILABLE" && <TouchableOpacity disabled={busy} onPress={()=>reserve(s.slot)} style={[styles.button,busy&&{opacity:0.5}]}><Text style={styles.buttonText}>Reserve ₹1</Text></TouchableOpacity>}
              </View>
            </View>
          );
        })}
        {slots.length === 0 && <Text style={styles.muted}>Loading live parking status…</Text>}
        <TouchableOpacity style={styles.refresh} onPress={loadSlots}><Text style={styles.refreshText}>↻ Refresh availability</Text></TouchableOpacity>
        <Text style={styles.footer}>A'Lot For Park · Live status depends on sensor connectivity.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:"#0b1220"},
  container:{padding:22,paddingTop:18,paddingBottom:45},
  header:{flexDirection:"row",alignItems:"center",gap:11,marginBottom:42},
  logo:{width:43,height:43,borderRadius:14,backgroundColor:"#173c43",alignItems:"center",justifyContent:"center"},
  logoText:{color:"#57e2c1",fontSize:23,fontWeight:"800"},
  brand:{color:"#f2f7f8",fontSize:16,fontWeight:"800"},
  subbrand:{color:"#7e91a5",fontSize:9,letterSpacing:2,marginTop:3},
  live:{flexDirection:"row",alignItems:"center",gap:6},
  dot:{width:7,height:7,borderRadius:4,backgroundColor:"#4cdbab"},
  liveText:{color:"#8ea5b4",fontSize:10,letterSpacing:1.5},
  kicker:{color:"#56d9b9",fontSize:10,letterSpacing:2,fontWeight:"800"},
  title:{fontSize:39,lineHeight:45,fontWeight:"800",color:"#edf4f7",marginTop:12},
  accent:{color:"#54d9b9"},
  muted:{color:"#91a2b3",lineHeight:22,marginTop:12,marginBottom:25},
  summary:{backgroundColor:"#142336",borderWidth:1,borderColor:"#263b50",borderRadius:18,padding:20,marginBottom:34},
  summaryLabel:{color:"#91a5b6",fontSize:10,letterSpacing:1.5},
  count:{color:"#54d9b9",fontSize:40,fontWeight:"800",marginTop:5},
  outOf:{color:"#91a5b6",fontSize:17,fontWeight:"500"},
  sectionRow:{flexDirection:"row",justifyContent:"space-between",alignItems:"center",marginBottom:14},
  sectionTitle:{color:"#edf4f7",fontSize:21,fontWeight:"800"},
  fee:{color:"#54d9b9",fontWeight:"700"},
  slot:{backgroundColor:"#121f30",borderWidth:1,borderColor:"#293b4d",borderRadius:16,padding:17,marginBottom:12,flexDirection:"row",justifyContent:"space-between",alignItems:"center"},
  slotName:{color:"#edf4f7",fontSize:18,fontWeight:"800"},
  slotDesc:{color:"#9caebd",fontSize:11,marginTop:7,maxWidth:180},
  tag:{fontSize:9,fontWeight:"900",letterSpacing:0.7,borderWidth:1,borderRadius:20,paddingVertical:7,paddingHorizontal:9,overflow:"hidden"},
  button:{backgroundColor:"#52dabb",borderRadius:9,paddingVertical:9,paddingHorizontal:12},
  buttonText:{color:"#09221c",fontSize:11,fontWeight:"900"},
  refresh:{alignSelf:"center",padding:15},
  refreshText:{color:"#9cb0c0"},
  footer:{color:"#62778a",fontSize:10,textAlign:"center",marginTop:24}
});
